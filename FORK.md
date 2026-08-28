# Fork differences

This repository is a public fork of [`deflating/tau`](https://github.com/deflating/tau). The `upstream` Git remote should continue to point there; `origin` points to this fork.

The fork keeps Tau's existing browser interface and terminal-owned Pi session model while adding:

- loopback-only mirror listeners by default;
- terminal-safe diagnostics that do not write over Pi's fullscreen UI;
- atomic PID/start-time-aware live-instance registration;
- path-prefix-aware HTTP, WebSocket, attachment, and service-worker URLs for a single-origin reverse proxy;
- newest-instance discovery support through registry timestamps;
- live-session indicators derived directly from the Tau registry rather than repeated process scans;
- an optional event protocol for remotely projecting safety confirmations;
- exact dependency pins and focused Node tests.

## Install this fork

```bash
pi install git:github.com/itissid/tau
```

## Update from upstream

```bash
git fetch upstream
git merge upstream/main
```

Resolve changes in the fork, run `npm test`, then push the tested result to `origin`.
