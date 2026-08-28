import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  apiPath,
  currentWebSocketUrl,
  instanceBasePath,
  instancePagePath,
  instancePath,
  instancePid,
  instanceWebSocketUrl,
} from "../../public/url-base.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(directory, "../../public");

test("Tau URLs preserve direct mirrors and stay beneath a hub PID prefix", () => {
  assert.equal(instancePid("/"), null);
  assert.equal(instanceBasePath("/app.js"), "");
  assert.equal(apiPath("health", "/"), "/api/health");
  assert.equal(instancePath("sw.js", "/"), "/sw.js");

  assert.equal(instancePid("/i/4101/"), 4101);
  assert.equal(instancePid("/i/4101/api/health"), 4101);
  assert.equal(instanceBasePath("/i/4101/app.js"), "/i/4101");
  assert.equal(apiPath("health", "/i/4101/"), "/i/4101/api/health");
  assert.equal(instancePath("icons/tau-192.png", "/i/4101/"), "/i/4101/icons/tau-192.png");
  assert.equal(instancePagePath(4102), "/i/4102/");
});

test("WebSocket instance switching changes the hub path, not its origin", () => {
  const hubLocation = {
    protocol: "https:",
    host: "tau.example.test",
    hostname: "tau.example.test",
    pathname: "/i/4101/",
  };
  assert.equal(currentWebSocketUrl(hubLocation), "wss://tau.example.test/i/4101/ws");
  assert.equal(
    instanceWebSocketUrl({ pid: 4102, port: 55060 }, hubLocation),
    "wss://tau.example.test/i/4102/ws",
  );

  const directLocation = {
    protocol: "http:",
    host: "127.0.0.1:55059",
    hostname: "127.0.0.1",
    pathname: "/",
  };
  assert.equal(currentWebSocketUrl(directLocation), "ws://127.0.0.1:55059/ws");
  assert.equal(
    instanceWebSocketUrl({ pid: 4102, port: 55060 }, directLocation),
    "ws://127.0.0.1:55060/ws",
  );
});

test("all Tau browser network call sites are instance-prefix aware", () => {
  for (const file of ["app.js", "file-browser.js", "launcher.js", "session-sidebar.js"]) {
    const source = readFileSync(path.join(publicDirectory, file), "utf8");
    assert.doesNotMatch(source, /fetch\(\s*[`'"]\/api\//, `${file} has a root API fetch`);
  }

  const app = readFileSync(path.join(publicDirectory, "app.js"), "utf8");
  assert.doesNotMatch(app, /location\.hostname.*instance\.port/);
  assert.match(app, /history\.replaceState\(null, '', instancePagePath\(otherInstance\.pid\)\)/);
  assert.doesNotMatch(app, /serviceWorker\.register\(instancePath\('sw\.js'\)\)/);

  const pushClient = readFileSync(path.join(publicDirectory, "push-notifications.js"), "utf8");
  assert.match(pushClient, /serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)/);
  assert.match(pushClient, /STALE_INSTANCE_SCOPE/);

  const manifest = JSON.parse(readFileSync(path.join(publicDirectory, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");

  const worker = readFileSync(path.join(publicDirectory, "sw.js"), "utf8");
  assert.match(worker, /notificationclick/);
  assert.match(worker, /tau-root-v3/);
});
