#!/usr/bin/env python3
"""Ground-truth PTY test for Tau/Pi fullscreen terminal ownership.

This test drives real Pi TUI processes, HTTP and WebSocket connections, a port
collision, graceful shutdown, and SIGKILL recovery. It rejects legacy Tau
diagnostic markers in PTY bytes; scenario occurrence is independently proven by
the non-terminal JSONL diagnostic sink.
"""

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
import urllib.request
from pathlib import Path
from typing import Any

REPOSITORY = Path(__file__).resolve().parents[1]
EXTENSION_DIR = REPOSITORY
FORBIDDEN_PTY_MARKERS = (
    b"[Mirror]",
    b"[mirror-server]",
    b"Browser client connected",
    b"Browser client disconnected",
    b'"event":"server_started"',
    b'"event":"browser_connected"',
    b'"event":"browser_disconnected"',
    b'"event":"port_collision"',
    b'"event":"server_stopped"',
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--evidence-dir",
        type=Path,
        help="Preserve raw PTY/TUI captures and summary in this directory",
    )
    return parser.parse_args()


def choose_base_port() -> int:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = int(probe.getsockname()[1])
    probe.close()
    if port > 65524:
        return 45101
    return port


class PtyPi:
    def __init__(self, label: str, cwd: Path, environment: dict[str, str], evidence: Path):
        self.label = label
        self.evidence = evidence
        self.pty_bytes = bytearray()
        self.tui_log = evidence / f"{label}.tui.raw"
        self.tui_log.unlink(missing_ok=True)
        child_environment = dict(environment)
        child_environment["PI_TUI_WRITE_LOG"] = str(self.tui_log)
        master, slave = pty.openpty()
        self.master = master
        self.process = subprocess.Popen(
            ["pi", "--no-session"],
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
        try:
            os.write(self.master, b"\x04")
            self.stop_method = "ctrl-d"
        except OSError:
            pass
        deadline = time.time() + 8
        while self.process.poll() is None and time.time() < deadline:
            self.drain(0.1)
        if self.process.poll() is None:
            self.stop_method = "sigterm-fallback"
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.stop_method = "sigkill-fallback"
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        self.drain(0.2)

    def abrupt_stop(self) -> None:
        self.stop_method = "sigkill"
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        self.drain(0.2)

    def force_cleanup(self) -> None:
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
            self.pty_bytes.decode("utf-8", "replace"), encoding="utf8"
        )


def read_registry(directory: Path) -> list[dict[str, Any]]:
    if not directory.exists():
        return []
    records: list[dict[str, Any]] = []
    for record_path in sorted(directory.glob("*.json")):
        try:
            records.append(json.loads(record_path.read_text(encoding="utf8")))
        except (json.JSONDecodeError, OSError):
            pass
    return records


def read_diagnostics(log_file: Path) -> list[dict[str, Any]]:
    if not log_file.exists():
        return []
    records = []
    for line in log_file.read_text(encoding="utf8").splitlines():
        if line.strip():
            records.append(json.loads(line))
    return records


def wait_for(
    processes: list[PtyPi],
    predicate,
    description: str,
    timeout: float = 15,
):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for process in processes:
            process.drain(0.03)
        value = predicate()
        if value:
            return value
        time.sleep(0.03)
    raise AssertionError(f"timed out waiting for {description}")


def http_json(port: int, path: str) -> dict[str, Any]:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as response:
        assert response.status == 200
        return json.loads(response.read())


def http_page(port: int) -> bytes:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as response:
        assert response.status == 200
        return response.read()


def websocket_connect(port: int) -> tuple[socket.socket, bytes]:
    connection = socket.create_connection(("127.0.0.1", port), timeout=5)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        "GET /ws HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    connection.sendall(request.encode("ascii"))
    response = connection.recv(4096)
    assert b"101 Switching Protocols" in response
    return connection, response


def main() -> int:
    args = parse_args()
    temporary_root = Path(tempfile.mkdtemp(prefix="tau-pty-learning-"))
    evidence = args.evidence_dir.resolve() if args.evidence_dir else temporary_root / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    home = temporary_root / "home"
    agent_dir = home / ".pi" / "agent"
    extension_link = agent_dir / "extensions" / "tau-mirror"
    project = temporary_root / "project-with-no-local-tau"
    registry = home / ".pi" / "tau-instances"
    log_file = agent_dir / "logs" / "tau-mirror.log"
    agent_dir.mkdir(parents=True)
    extension_link.parent.mkdir(parents=True)
    project.mkdir()
    extension_link.symlink_to(EXTENSION_DIR, target_is_directory=True)
    (agent_dir / "settings.json").write_text(
        json.dumps({"tuiMode": "fullscreen", "packages": []}) + "\n",
        encoding="utf8",
    )

    base_port = choose_base_port()
    environment = {
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "PI_CODING_AGENT_DIR": str(agent_dir),
        "SHELL": "/bin/bash",
        "TAU_HOST": "0.0.0.0",  # Must be restricted to loopback by the extension.
        "TAU_LOG_FILE": str(log_file),
        "TAU_MIRROR_PORT": str(base_port),
        "TERM": "xterm-256color",
    }

    processes: list[PtyPi] = []
    snapshots: dict[str, Any] = {}
    summary: dict[str, Any] = {
        "hypothesis": (
            "routing Tau diagnostics away from stdout/stderr prevents out-of-band bytes "
            "during real fullscreen Pi lifecycle scenarios"
        ),
        "falsifier": (
            "a legacy Tau marker appears in any PTY capture, or a required scenario is "
            "missing from the non-terminal diagnostic log"
        ),
        "basePort": base_port,
        "canonicalExtension": str(EXTENSION_DIR),
        "installedLink": str(extension_link),
        "resolvedInstalledLink": str(extension_link.resolve()),
        "projectLocalTauExists": (project / ".pi" / "extensions" / "tau-mirror").exists(),
    }

    try:
        first = PtyPi("pi-1", project, environment, evidence)
        processes.append(first)
        first_records = wait_for(
            processes,
            lambda: [record for record in read_registry(registry) if record["pid"] == first.process.pid],
            "first live registry record",
        )
        first_port = first_records[0]["port"]
        assert first_port == base_port
        assert first_records[0]["host"] == "127.0.0.1"
        assert b"<title>Tau</title>" in http_page(first_port)
        assert http_json(first_port, "/api/health")["mirrorUrl"] == f"http://127.0.0.1:{first_port}"

        browser, handshake = websocket_connect(first_port)
        assert b"101 Switching Protocols" in handshake
        wait_for(
            processes,
            lambda: any(
                record["pid"] == first.process.pid and record["event"] == "browser_connected"
                for record in read_diagnostics(log_file)
            ),
            "browser connection diagnostic",
        )
        browser.close()
        wait_for(
            processes,
            lambda: any(
                record["pid"] == first.process.pid and record["event"] == "browser_disconnected"
                for record in read_diagnostics(log_file)
            ),
            "browser disconnection diagnostic",
        )

        second = PtyPi("pi-2", project, environment, evidence)
        processes.append(second)
        two_records = wait_for(
            processes,
            lambda: read_registry(registry) if len(read_registry(registry)) == 2 else None,
            "two live registry records",
        )
        records_by_pid = {record["pid"]: record for record in two_records}
        assert set(records_by_pid) == {first.process.pid, second.process.pid}
        assert records_by_pid[first.process.pid]["port"] == base_port
        assert records_by_pid[second.process.pid]["port"] == base_port + 1
        assert all(record["host"] == "127.0.0.1" for record in two_records)
        assert first.process.poll() is None and second.process.poll() is None
        assert http_json(base_port, "/api/health")["status"] == "ok"
        assert http_json(base_port + 1, "/api/health")["status"] == "ok"
        wait_for(
            processes,
            lambda: any(
                record["pid"] == second.process.pid and record["event"] == "port_collision"
                for record in read_diagnostics(log_file)
            ),
            "port collision diagnostic",
        )
        snapshots["twoLiveProcesses"] = two_records

        first.graceful_stop()
        assert first.process.returncode == 0
        wait_for(
            processes,
            lambda: all(record["pid"] != first.process.pid for record in read_registry(registry)),
            "clean shutdown registry removal",
        )
        snapshots["afterCleanShutdown"] = read_registry(registry)

        second.abrupt_stop()
        abrupt_records = read_registry(registry)
        assert any(record["pid"] == second.process.pid for record in abrupt_records)
        snapshots["immediatelyAfterSigkill"] = abrupt_records

        third = PtyPi("pi-3", project, environment, evidence)
        processes.append(third)
        third_records = wait_for(
            processes,
            lambda: [record for record in read_registry(registry) if record["pid"] == third.process.pid],
            "replacement process registry record",
        )
        assert len(third_records) == 1
        assert third_records[0]["port"] == base_port
        assert all(record["pid"] != second.process.pid for record in read_registry(registry))
        snapshots["afterAbruptRecovery"] = read_registry(registry)

        third.graceful_stop()
        assert third.process.returncode == 0
        wait_for(
            processes,
            lambda: not read_registry(registry),
            "final clean registry removal",
        )
        snapshots["finalRegistry"] = read_registry(registry)

        diagnostics = read_diagnostics(log_file)
        required_events = {
            "server_started",
            "browser_connected",
            "browser_disconnected",
            "port_collision",
            "server_stopped",
        }
        observed_events = {record["event"] for record in diagnostics}
        assert required_events <= observed_events

        process_evidence = {}
        for process in processes:
            process.drain(0.1)
            forbidden = [
                marker.decode("utf8", "replace")
                for marker in FORBIDDEN_PTY_MARKERS
                if marker in process.pty_bytes
            ]
            assert forbidden == [], f"{process.label} leaked Tau diagnostics: {forbidden}"
            assert process.tui_log.exists() and process.tui_log.stat().st_size > 0
            process_evidence[process.label] = {
                "pid": process.process.pid,
                "exitCode": process.process.returncode,
                "stopMethod": process.stop_method,
                "ptyBytes": len(process.pty_bytes),
                "ptySha256": hashlib.sha256(process.pty_bytes).hexdigest(),
                "tuiWriteLogBytes": process.tui_log.stat().st_size,
                "forbiddenPtyMarkers": forbidden,
            }

        summary.update(
            {
                "outcome": "pass",
                "requiredDiagnosticEvents": sorted(required_events),
                "observedDiagnosticEvents": sorted(observed_events),
                "processes": process_evidence,
                "registrySnapshots": snapshots,
                "remainingRegistryRecords": read_registry(registry),
            }
        )
    except Exception as error:
        summary.update({"outcome": "fail", "error": repr(error), "registrySnapshots": snapshots})
        raise
    finally:
        for process in processes:
            process.force_cleanup()
        (evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf8")
        if args.evidence_dir:
            if log_file.exists():
                shutil.copy2(log_file, evidence / "tau-mirror.log")
            print(json.dumps(summary, indent=2))
        else:
            print(json.dumps(summary, indent=2))
            shutil.rmtree(temporary_root, ignore_errors=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
