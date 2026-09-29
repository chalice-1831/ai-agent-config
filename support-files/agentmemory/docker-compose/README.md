# agentmemory Docker Compose

This directory contains the maintained Docker Compose runtime for `agentmemory` used by local agents such as OpenCode and Codex.

## Files

- `docker-compose.yml`: builds and runs `agentmemory`.
- `Dockerfile`: pins `@agentmemory/agentmemory` and the iii runtime to compatible versions.
- `entrypoint.sh`: prepares persistent storage, generates the HMAC secret, and starts `agentmemory`.
- `.env.example`: environment template. Copy it to `.env` and fill local values. Do not commit `.env`.

## Ports

- `3111`: REST/MCP API, mapped to container port `3111` and bound to `0.0.0.0` on the host for other machines or agents.
- `3113`: agentmemory viewer, mapped to container port `3113` and bound to `127.0.0.1` on the host.

The compose file fixes the internal viewer bind host to `0.0.0.0` so Docker can publish the viewer port. Do not treat `AGENTMEMORY_VIEWER_HOST` as an operator setting. Control external access with the `ports` mappings and `VIEWER_ALLOWED_HOSTS` instead.

If you expose the viewer through another host name, IP, or reverse proxy, add the exact incoming Host header to `VIEWER_ALLOWED_HOSTS` in `.env`.

## Quick Start

```bash
cd support-files/agentmemory/docker-compose
cp .env.example .env
$EDITOR .env
docker compose up -d --build
```

Get the generated MCP secret from the first boot logs:

```bash
docker compose logs agentmemory | grep AGENTMEMORY_SECRET
```

Verify the API:

```bash
curl -fsS http://127.0.0.1:3111/agentmemory/livez
```

Open the dashboard from the same host:

```text
http://127.0.0.1:3113
```

## Agent Environment

Start agents that should use this server with:

```bash
export AGENTMEMORY_URL=http://127.0.0.1:3111
export AGENTMEMORY_SECRET='<value from docker compose logs>'
```

Use the host IP instead of `127.0.0.1` when the agent runs on another machine.

## Embeddings and Graph Extraction

This Compose file defaults the OpenAI-compatible embedding model to:

```text
AGENTMEMORY_EMBEDDING_MODEL=Qwen3-Embedding-8B
AGENTMEMORY_EMBEDDING_DIMENSIONS=4096
```

Enable compression, context injection, and graph extraction in `.env` only after an LLM-compatible provider is configured.
