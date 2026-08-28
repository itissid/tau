# Tau Hub

Tau Hub is Tau's separately managed, single-origin discovery and reverse-proxy process for terminal-owned Tau mirrors. It never starts Pi and never owns an agent or session.

The Hub lives in this repository because its routes, registry protocol, browser paths, PWA assets, and safety-request marker protocol evolve with the Tau extension. Deployment adapters remain with the environment that owns the Pi processes.

## Routes

- `/` redirects to the newest live registry instance by `startedAt`, or reports that no terminal Pi is active.
- `/healthz` reports Hub health and the current live PID set.
- `/i/<pid>/...` resolves `<pid>` against the Tau registry, strips the instance prefix, and streams HTTP to that mirror's registry-published loopback listener.
- `/i/<pid>/ws` tunnels WebSocket Upgrade traffic to the selected mirror's `/ws` endpoint.
- `/sw.js`, `/manifest.webmanifest`, and root icon routes serve the one origin-wide PWA worker and manifest.
- `GET /api/push/vapid-public-key` returns only the VAPID public key.
- `POST` and `DELETE /api/push/subscriptions` add/update or remove the caller's subscription. There is deliberately no public notification-send endpoint.

Unknown or dead PIDs return `410`. The Hub accepts no caller-supplied upstream host or port and rejects registry records whose host is not loopback.

## Push ownership and state

Tau mirrors atomically publish only bounded safety-request routing metadata under `TAU_PENDING_DIR`; markers exclude protected tool input and unrelated prompt content. The Hub polls those local markers, validates each marker against the live PID/start identity, and sends one Web Push per active subscription. Marker removal on approval, denial, cancellation, or Pi shutdown cleans delivery deduplication state. Push responses `404` and `410` remove expired subscriptions.

`TAU_HUB_STATE_DIR` contains one VAPID key pair, subscriptions, and endpoint-hash delivery deduplication. The directory is mode `0700`; files are atomically replaced at mode `0600`. Never print, copy into tracked files, or expose this state through HTTP, logs, result artifacts, or browser configuration.

## Runtime boundary

Tau mirrors bind to loopback and publish PID-scoped registry records. A deployment adapter must therefore place the Hub where it can reach those loopback listeners and validate their owning PIDs. For containerized Pi environments this normally means sharing the Pi container's network and PID namespaces and exposing the registry and pending-marker paths through that namespace.

The environment-specific Compose, Tailscale identity, storage, and rollout policy do not belong to Tau. For example, the devbox repository retains its deployment adapter while building this repository's `hub/Dockerfile`.

## Development

```bash
npm ci --ignore-scripts
npm --prefix hub ci --ignore-scripts
npm test
```

Run the slower real-process learning test separately:

```bash
npm run test:mirrors
```

Build the Hub image from the Tau repository root:

```bash
docker build -f hub/Dockerfile .
```
