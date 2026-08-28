FROM node:24.11.0-bookworm-slim@sha256:76d0ed0ed93bed4f4376211e9d8fddac4d8b3fbdb54cc45955696001a3c91152

WORKDIR /app

COPY hub/package.json hub/package-lock.json ./hub/
RUN cd hub && npm ci --omit=dev --ignore-scripts

COPY hub/ ./hub/
COPY extensions/pending-request-markers.ts ./extensions/pending-request-markers.ts
COPY extensions/registry.ts ./extensions/registry.ts
COPY extensions/safety-gate-protocol.ts ./extensions/safety-gate-protocol.ts
COPY public/ ./public/

USER node
WORKDIR /app/hub

ENV TAU_HUB_HOST=127.0.0.1 \
    TAU_HUB_PORT=3000 \
    TAU_HUB_STATE_DIR=/var/lib/tau-hub \
    TAU_INSTANCES_DIR=/home/dev/.pi/tau-instances \
    TAU_PENDING_DIR=/home/dev/.pi/tau-pending

CMD ["node", "server.ts"]
