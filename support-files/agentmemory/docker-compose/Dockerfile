# syntax=docker/dockerfile:1
ARG III_VERSION=0.25.0
ARG NODE_VERSION=24-bookworm-slim

FROM iiidev/iii:${III_VERSION} AS iii-engine

FROM node:${NODE_VERSION} AS dependencies
WORKDIR /opt/agentmemory
ARG AGENTMEMORY_VERSION=0.9.31
RUN --mount=type=cache,target=/root/.npm \
    npm install --save-exact --omit=dev --omit=optional --no-fund --no-audit \
      "@agentmemory/agentmemory@${AGENTMEMORY_VERSION}"

FROM node:${NODE_VERSION}
ARG III_VERSION
ARG STATE_VERSION=0.22.20
ARG HTTP_VERSION=0.22.7

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini gosu \
 && rm -rf /var/lib/apt/lists/*

COPY --from=iii-engine /app/iii /usr/local/bin/iii
RUN iii --version 2>&1 | grep -qF "${III_VERSION}" \
 || { echo "Expected iii ${III_VERSION}" >&2; exit 1; }

WORKDIR /opt/agentmemory
COPY --from=dependencies /opt/agentmemory/node_modules ./node_modules
# Match the upstream deployment layout while installing the published npm release.
RUN ln -s node_modules/@agentmemory/agentmemory/dist dist \
 && ln -s /opt/agentmemory/dist/cli.mjs /usr/local/bin/agentmemory
COPY worker-compose.yaml iii.worker.yaml ./
COPY --chmod=0755 entrypoint.sh /usr/local/bin/agentmemory-entrypoint.sh

ENV III_VERSION=${III_VERSION} \
    STATE_VERSION=${STATE_VERSION} \
    HTTP_VERSION=${HTTP_VERSION} \
    AGENTMEMORY_DATA_DIR=/data \
    HOME=/data/home \
    III_COMPOSE_STATE_DIR=/data/compose-state \
    III_ENGINE_PORT=49134 \
    III_REST_PORT=3111 \
    III_VIEWER_PORT=3113 \
    III_TELEMETRY_ENABLED=false \
    MALLOC_ARENA_MAX=2 \
    TINI_SUBREAPER=1

EXPOSE 3111 3113

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3111/agentmemory/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agentmemory-entrypoint.sh"]
