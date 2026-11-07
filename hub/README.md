# Tau Hub

Tau Hub is Tau's separately managed, single-origin discovery and reverse-proxy process for terminal-owned Tau Mirrors. It never starts Pi and never owns an agent or session.

Tau Hub lives in this repository because its routes, registry protocol, browser paths, PWA assets, and safety-request marker protocol evolve with the Tau Extension. Deployment Adapters remain with the environment that owns the Pi processes. See [`../CONTEXT.md`](../CONTEXT.md) for canonical terminology.

## Routes

- `/` redirects to the newest live Tau Mirror by `startedAt`, or reports that no terminal Pi is active.
- `/healthz` reports Hub health and the current live PID set.
- `/i/<pid>/...` resolves `<pid>` against the Tau Mirror registry, strips the mirror path prefix, and streams HTTP to that mirror's registry-published loopback listener.
- `/i/<pid>/ws` tunnels WebSocket Upgrade traffic to the selected mirror's `/ws` endpoint.
- `/sw.js`, `/manifest.webmanifest`, and root icon routes serve the one origin-wide PWA worker and manifest.
- `GET /api/push/vapid-public-key` returns only the VAPID public key.
- `POST` and `DELETE /api/push/subscriptions` add/update or remove the caller's subscription.
- `POST /api/push/notification-events` accepts a strict, bounded notification lifecycle record from Tau's service worker or session page. There is no HTTP read route for these records and deliberately no public notification-send endpoint.

Unknown or dead PIDs return `410`. The Hub accepts no caller-supplied upstream host or port and rejects registry records whose host is not loopback.

## Push ownership and state

Tau Mirrors atomically publish only bounded safety-request routing metadata under `TAU_PENDING_DIR`; markers exclude protected tool input and unrelated prompt content. Tau Hub polls those local markers, validates each marker against the live PID/start identity, and sends one Web Push per active subscription. Marker removal on approval, denial, cancellation, or Pi shutdown cleans delivery deduplication state. Push responses `404` and `410` remove expired subscriptions.

`TAU_HUB_STATE_DIR` contains one VAPID key pair, subscriptions, endpoint-hash delivery deduplication, and `notification-events.jsonl`. Notification records correlate only bounded request IDs, PIDs, target routes, browser lifecycle stages, and outcomes; protected tool input, prompts, subscription details, and free-form errors are rejected. The directory is mode `0700`; state files are mode `0600`. Never print or copy VAPID keys, subscriptions, or endpoint hashes into tracked files, logs, result artifacts, or browser configuration. Notification-event excerpts may be inspected locally only after confirming their bounded schema.

## Runtime boundary

Tau Mirrors bind to loopback and publish PID-scoped registry records. A Deployment Adapter must therefore place Tau Hub where it can reach those loopback listeners and validate their owning PIDs. For containerized Pi environments this normally means sharing the Pi container's network and PID namespaces and exposing the registry and pending-marker paths through that namespace.

The environment-specific Compose, Tailscale identity, storage, and rollout policy do not belong to Tau. For example, the devbox repository retains its Deployment Adapter while building this repository's `hub/Dockerfile`.

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
