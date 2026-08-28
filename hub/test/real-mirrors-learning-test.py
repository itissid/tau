#!/usr/bin/env python3
"""Ground-truth Ticket 02 probe with two real terminal-owned Pi/Tau mirrors."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import pty
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

HUB_DIR = Path(__file__).resolve().parents[1]
REPOSITORY = HUB_DIR.parent
MIRROR_DIR = REPOSITORY


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-dir", type=Path)
    return parser.parse_args()


def free_port() -> int:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = int(probe.getsockname()[1])
    probe.close()
    return port


def choose_mirror_base_port() -> int:
    while True:
        port = free_port()
        if port < 65534:
            second = socket.socket()
            try:
                second.bind(("127.0.0.1", port + 1))
                return port
            except OSError:
                pass
            finally:
                second.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


NO_REDIRECT = urllib.request.build_opener(NoRedirect)


def http_request(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    follow_redirects: bool = True,
) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(url, data=data, headers=headers or {})
    open_request = urllib.request.urlopen if follow_redirects else NO_REDIRECT.open
    try:
        with open_request(request, timeout=5) as response:
            return response.status, dict(response.headers.items()), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read()


def http_json(url: str, **kwargs: Any) -> tuple[int, dict[str, str], dict[str, Any]]:
    status, headers, body = http_request(url, **kwargs)
    return status, headers, json.loads(body)


def wait_for(processes: list["PtyPi"], predicate, description: str, timeout: float = 20):
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        for process in processes:
            process.drain(0.02)
        try:
            value = predicate()
            if value:
                return value
        except (OSError, urllib.error.URLError) as error:
            last_error = error
        time.sleep(0.03)
    suffix = f": {last_error!r}" if last_error else ""
    raise AssertionError(f"timed out waiting for {description}{suffix}")


def read_registry(directory: Path) -> list[dict[str, Any]]:
    if not directory.exists():
        return []
    records = []
    for record_path in sorted(directory.glob("*.json")):
        try:
            records.append(json.loads(record_path.read_text(encoding="utf8")))
        except (json.JSONDecodeError, OSError):
            continue
    return records


class PtyPi:
    def __init__(self, label: str, cwd: Path, environment: dict[str, str], evidence: Path):
        self.label = label
        self.evidence = evidence
        self.pty_bytes = bytearray()
        self.tui_log = evidence / f"{label}.tui.raw"
        child_environment = dict(environment)
        child_environment["PI_TUI_WRITE_LOG"] = str(self.tui_log)
        master, slave = pty.openpty()
        self.master = master
        self.process = subprocess.Popen(
            ["pi", "--no-session", "--offline"],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=cwd,
            env=child_environment,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave)
        os.set_blocking(master, False)
        self.stop_method: str | None = None

    def drain(self, duration: float = 0.1) -> None:
        deadline = time.time() + duration
        while time.time() < deadline:
            ready, _, _ = select.select(
                [self.master], [], [], min(0.05, max(0.0, deadline - time.time()))
            )
            if not ready:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except (BlockingIOError, OSError):
                break
            if not chunk:
                break
            self.pty_bytes.extend(chunk)

    def graceful_stop(self) -> None:
        if self.process.poll() is not None:
            return
        os.write(self.master, b"\x04")
        self.stop_method = "ctrl-d"
        deadline = time.time() + 8
        while self.process.poll() is None and time.time() < deadline:
            self.drain(0.1)
        if self.process.poll() is None:
            self.stop_method = "sigterm-fallback"
            os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=5)
        self.drain(0.2)

    def abrupt_stop(self) -> None:
        if self.process.poll() is None:
            self.stop_method = "sigkill"
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        self.drain(0.2)

    def cleanup(self) -> None:
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        self.drain(0.1)
        try:
            os.close(self.master)
        except OSError:
            pass
        (self.evidence / f"{self.label}.pty.raw").write_bytes(self.pty_bytes)
        (self.evidence / f"{self.label}.pty.txt").write_text(
            self.pty_bytes.decode("utf8", "replace"), encoding="utf8"
        )


def websocket_probe(url: str) -> dict[str, Any]:
    script = r"""
const url = process.argv[1];
const ws = new WebSocket(url);
const messages = [];
const timer = setTimeout(() => { console.error('timeout'); process.exit(2); }, 5000);
ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'learning-state', type: 'get_state' })));
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  messages.push(message);
  const hasSync = messages.some((item) => item.type === 'mirror_sync');
  const hasResponse = messages.some((item) => item.type === 'response' && item.id === 'learning-state');
  if (hasSync && hasResponse) {
    clearTimeout(timer);
    console.log(JSON.stringify({
      url,
      messageTypes: messages.map((item) => item.type),
      sessionFile: messages.find((item) => item.type === 'mirror_sync')?.sessionFile ?? null,
      responseSuccess: messages.find((item) => item.type === 'response')?.success ?? false,
    }));
    ws.close();
  }
});
ws.addEventListener('error', () => { clearTimeout(timer); process.exit(3); });
"""
    result = subprocess.run(
        ["node", "-e", script, url],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return json.loads(result.stdout)


def main() -> int:
    args = parse_args()
    temporary_root = Path(tempfile.mkdtemp(prefix="tau-hub-learning-"))
    evidence = args.evidence_dir.resolve() if args.evidence_dir else temporary_root / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    home = temporary_root / "home"
    agent_dir = home / ".pi" / "agent"
    registry = home / ".pi" / "tau-instances"
    project_one = temporary_root / "project-one"
    project_two = temporary_root / "project-two"
    extension_link = agent_dir / "extensions" / "tau-mirror"
    log_file = agent_dir / "logs" / "tau-mirror.log"
    hub_log = evidence / "tau-hub.log"
    for directory in (agent_dir, project_one, project_two):
        directory.mkdir(parents=True, exist_ok=True)
    extension_link.parent.mkdir(parents=True, exist_ok=True)
    extension_link.symlink_to(MIRROR_DIR, target_is_directory=True)
    (agent_dir / "settings.json").write_text(
        json.dumps({"tuiMode": "fullscreen", "packages": []}) + "\n",
        encoding="utf8",
    )
    attachment = project_one / "attachment.png"
    attachment.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    )

    mirror_port = choose_mirror_base_port()
    hub_port = free_port()
    while hub_port in (mirror_port, mirror_port + 1):
        hub_port = free_port()

    common_environment = {
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "PI_CODING_AGENT_DIR": str(agent_dir),
        "SHELL": "/bin/bash",
        "TAU_HOST": "127.0.0.1",
        "TAU_INSTANCES_DIR": str(registry),
        "TAU_LOG_FILE": str(log_file),
        "TAU_MIRROR_PORT": str(mirror_port),
        "TERM": "xterm-256color",
    }
    hub_environment = {
        **common_environment,
        "TAU_HUB_HOST": "127.0.0.1",
        "TAU_HUB_PORT": str(hub_port),
    }

    processes: list[PtyPi] = []
    hub_output = hub_log.open("wb")
    hub = subprocess.Popen(
        ["node", "server.ts"],
        cwd=HUB_DIR,
        env=hub_environment,
        stdout=hub_output,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    origin = f"http://127.0.0.1:{hub_port}"
    summary: dict[str, Any] = {
        "hypothesis": (
            "one separately started registry-aware hub transparently routes two real "
            "terminal-owned Tau mirrors beneath one origin"
        ),
        "falsifier": (
            "prefixed HTTP/WebSocket behavior diverges from direct mirrors, a caller chooses "
            "a port, the hub owns Pi, or a dead PID remains routable"
        ),
        "hubPid": hub.pid,
        "hubOrigin": origin,
        "mirrorBasePort": mirror_port,
        "registry": str(registry),
    }

    try:
        empty_health = wait_for(
            processes,
            lambda: http_json(f"{origin}/healthz")[2]
            if hub.poll() is None
            else None,
            "hub health before Pi starts",
        )
        assert empty_health["activeInstances"] == 0
        empty_root = http_request(f"{origin}/", follow_redirects=False)
        assert empty_root[0] == 503
        summary["beforePi"] = {
            "hubHealth": empty_health,
            "rootStatus": empty_root[0],
            "rootTruth": "No terminal-owned Tau instances are active" in empty_root[2].decode(),
        }

        first = PtyPi("pi-1", project_one, common_environment, evidence)
        processes.append(first)
        first_record = wait_for(
            processes,
            lambda: next(
                (record for record in read_registry(registry) if record["pid"] == first.process.pid),
                None,
            ),
            "first terminal-owned mirror",
        )
        first_root = http_request(f"{origin}/", follow_redirects=False)
        assert first_root[0] == 302
        assert first_root[1]["Location"] == f"/i/{first.process.pid}/"

        second = PtyPi("pi-2", project_two, common_environment, evidence)
        processes.append(second)
        two_records = wait_for(
            processes,
            lambda: read_registry(registry) if len(read_registry(registry)) == 2 else None,
            "two terminal-owned mirrors",
        )
        records_by_pid = {record["pid"]: record for record in two_records}
        assert set(records_by_pid) == {first.process.pid, second.process.pid}
        assert records_by_pid[first.process.pid]["port"] == mirror_port
        assert records_by_pid[second.process.pid]["port"] == mirror_port + 1
        assert hub.pid == summary["hubPid"] and hub.poll() is None
        newest_root = http_request(f"{origin}/", follow_redirects=False)
        assert newest_root[0] == 302
        assert newest_root[1]["Location"] == f"/i/{second.process.pid}/"

        # The test harness owns the Pi children; the hub process itself owns none.
        hub_children_path = Path(f"/proc/{hub.pid}/task/{hub.pid}/children")
        hub_children = hub_children_path.read_text(encoding="utf8").strip()
        assert hub_children == ""

        pid_one = first.process.pid
        pid_two = second.process.pid
        prefix_one = f"{origin}/i/{pid_one}"
        prefix_two = f"{origin}/i/{pid_two}"

        page_status, _, page = http_request(f"{prefix_one}/")
        app_status, _, app = http_request(f"{prefix_one}/app.js")
        helper_status, _, helper = http_request(f"{prefix_one}/url-base.js")
        style_status, style_headers, style = http_request(f"{prefix_one}/style.css")
        worker_status, _, worker = http_request(f"{prefix_one}/sw.js")
        manifest_status, _, manifest_body = http_request(f"{prefix_one}/manifest.json")
        root_worker_status, root_worker_headers, root_worker = http_request(f"{origin}/sw.js")
        root_manifest_status, _, root_manifest_body = http_request(f"{origin}/manifest.webmanifest")
        assert {
            page_status,
            app_status,
            helper_status,
            style_status,
            worker_status,
            manifest_status,
            root_worker_status,
            root_manifest_status,
        } == {200}
        assert b"<title>Tau</title>" in page
        assert b"from './url-base.js'" in app
        assert b"instanceWebSocketUrl" in helper
        assert "text/css" in style_headers["Content-Type"]
        assert b"notificationclick" in worker
        assert b"notificationclick" in root_worker
        assert root_worker_headers["Service-Worker-Allowed"] == "/"
        manifest = json.loads(manifest_body)
        root_manifest = json.loads(root_manifest_body)
        assert manifest["start_url"] == "/" and manifest["scope"] == "/"
        assert root_manifest["start_url"] == "/" and root_manifest["scope"] == "/"

        first_api = http_json(f"{prefix_one}/api/health")[2]
        second_api = http_json(f"{prefix_two}/api/health")[2]
        direct_first = http_json(f"http://127.0.0.1:{mirror_port}/api/health")[2]
        direct_second = http_json(f"http://127.0.0.1:{mirror_port + 1}/api/health")[2]
        assert first_api["status"] == second_api["status"] == "ok"
        assert direct_first["status"] == direct_second["status"] == "ok"

        instances = http_json(f"{prefix_one}/api/instances")[2]["instances"]
        assert {record["pid"] for record in instances} == {pid_one, pid_two}
        files = http_json(f"{prefix_one}/api/files")[2]
        assert any(item["name"] == "attachment.png" for item in files["items"])
        preview_status, preview_headers, preview = http_request(
            f"{prefix_one}/api/file/preview?path={urllib.parse.quote(str(attachment))}"
        )
        assert preview_status == 200
        assert preview_headers["Content-Type"] == "image/png"
        assert preview == attachment.read_bytes()

        rpc_payload = json.dumps({"type": "get_state"}).encode()
        rpc_status, _, rpc = http_json(
            f"{prefix_two}/api/rpc",
            data=rpc_payload,
            headers={"Content-Type": "application/json"},
        )
        assert rpc_status == 200 and rpc["success"] is True

        direct_ws = websocket_probe(f"ws://127.0.0.1:{mirror_port}/ws")
        first_ws = websocket_probe(f"ws://127.0.0.1:{hub_port}/i/{pid_one}/ws")
        second_ws = websocket_probe(f"ws://127.0.0.1:{hub_port}/i/{pid_two}/ws")
        for probe in (direct_ws, first_ws, second_ws):
            assert "mirror_sync" in probe["messageTypes"]
            assert probe["responseSuccess"] is True
        assert first_ws["url"].split(f"/i/{pid_one}/")[0] == second_ws["url"].split(f"/i/{pid_two}/")[0]

        # A query-string port remains application data. Tau rejects this non-existent API
        # variant instead of the hub interpreting it as an upstream selector.
        arbitrary_port_status, _, arbitrary_port = http_json(
            f"{prefix_one}/api/health?port={mirror_port + 1}"
        )
        assert arbitrary_port_status == 404
        assert arbitrary_port == {"error": "Not found"}

        summary["twoLiveMirrors"] = {
            "records": two_records,
            "terminalOwnerPids": [pid_one, pid_two],
            "hubChildren": hub_children,
            "hubPidUnchanged": hub.pid == summary["hubPid"],
            "singleInstanceRootRedirect": first_root[1]["Location"],
            "newestInstanceRootRedirect": newest_root[1]["Location"],
            "prefixedAssets": {
                "pageBytes": len(page),
                "appSha256": hashlib.sha256(app).hexdigest(),
                "helperSha256": hashlib.sha256(helper).hexdigest(),
                "styleBytes": len(style),
                "serviceWorkerBytes": len(worker),
                "rootServiceWorkerBytes": len(root_worker),
                "manifest": {"start_url": manifest["start_url"], "scope": manifest["scope"]},
                "rootManifest": {
                    "start_url": root_manifest["start_url"],
                    "scope": root_manifest["scope"],
                },
            },
            "apis": {
                "firstMirrorUrl": first_api["mirrorUrl"],
                "secondMirrorUrl": second_api["mirrorUrl"],
                "instancePids": sorted(record["pid"] for record in instances),
                "filePath": files["path"],
                "rpcSuccess": rpc["success"],
            },
            "attachment": {
                "status": preview_status,
                "contentType": preview_headers["Content-Type"],
                "sha256": hashlib.sha256(preview).hexdigest(),
            },
            "webSockets": {
                "direct": direct_ws,
                "prefixedFirst": first_ws,
                "prefixedSecond": second_ws,
                "switchPaths": [f"/i/{pid_one}/ws", f"/i/{pid_two}/ws"],
                "sameOrigin": True,
            },
            "callerPortIgnored": {
                "requestedPort": mirror_port + 1,
                "status": arbitrary_port_status,
                "upstreamApplicationResponse": arbitrary_port,
            },
        }

        first.abrupt_stop()
        stale_before_request = read_registry(registry)
        assert any(record["pid"] == pid_one for record in stale_before_request)
        stale_status, _, stale_body = http_request(f"{prefix_one}/api/health")
        assert stale_status == 410
        assert b"no longer active" in stale_body
        stale_after_request = read_registry(registry)
        assert all(record["pid"] != pid_one for record in stale_after_request)
        assert http_json(f"{prefix_two}/api/health")[2]["status"] == "ok"
        root_after_stale = http_request(f"{origin}/", follow_redirects=False)
        assert root_after_stale[1]["Location"] == f"/i/{pid_two}/"

        summary["staleInstance"] = {
            "staleRecordBeforeHubRequest": any(record["pid"] == pid_one for record in stale_before_request),
            "prefixedStatus": stale_status,
            "registryPidsAfterHubRequest": [record["pid"] for record in stale_after_request],
            "remainingRootRedirect": root_after_stale[1]["Location"],
            "secondMirrorStillReachable": True,
            "hubPidUnchanged": hub.pid == summary["hubPid"] and hub.poll() is None,
        }

        second.graceful_stop()
        assert second.process.returncode == 0
        wait_for(processes, lambda: not read_registry(registry), "empty registry after clean stop")
        final_root = http_request(f"{origin}/", follow_redirects=False)
        assert final_root[0] == 503
        final_health = http_json(f"{origin}/healthz")[2]
        assert final_health["activeInstances"] == 0
        summary["afterAllPiStopped"] = {
            "rootStatus": final_root[0],
            "hubHealth": final_health,
            "hubStillRunning": hub.poll() is None,
        }
        summary["outcome"] = "pass"
    except Exception as error:
        summary.update({"outcome": "fail", "error": repr(error), "registrySnapshot": read_registry(registry)})
        raise
    finally:
        for process in processes:
            process.cleanup()
        if hub.poll() is None:
            os.killpg(hub.pid, signal.SIGTERM)
            try:
                hub.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(hub.pid, signal.SIGKILL)
                hub.wait(timeout=5)
        hub_output.close()
        summary["hubExitCode"] = hub.returncode
        summary["processes"] = {
            process.label: {
                "pid": process.process.pid,
                "exitCode": process.process.returncode,
                "stopMethod": process.stop_method,
                "ptyBytes": len(process.pty_bytes),
                "ptySha256": hashlib.sha256(process.pty_bytes).hexdigest(),
            }
            for process in processes
        }
        (evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf8")
        print(json.dumps(summary, indent=2))
        if not args.evidence_dir:
            shutil.rmtree(temporary_root, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
