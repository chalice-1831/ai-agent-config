# agentmemory Docker Compose

这个目录维护本机 agent 使用的 `agentmemory` Docker Compose 运行环境，例如 OpenCode 和 Codex。

## 文件

- `docker-compose.yml`: 构建并运行 `agentmemory`。
- `Dockerfile`: 分离 npm 依赖安装与运行阶段，固定 `@agentmemory/agentmemory` 0.9.31、iii 0.25.0、state 0.22.20 和 http 0.22.7。
- `entrypoint.sh`: 准备持久化存储、迁移旧凭据，并通过 iii Worker Compose 启动服务。
- `worker-compose.yaml`: 定义 state、http 和 agentmemory worker，启动应用前探测 `state::get` 是否可用，并显式转发本 Compose stack 的环境变量。
- `iii.worker.yaml`: agentmemory worker 的启动声明。
- `.env.example`: 环境变量模板。复制为 `.env` 后填写本机值，不要提交 `.env`。

## 端口

- `3111`: REST/MCP API，映射到容器端口 `3111`，并在宿主机绑定到 `0.0.0.0`，供其他机器或 agent 访问。
- `3113`: agentmemory viewer，映射到容器端口 `3113`，并在宿主机绑定到 `127.0.0.1`。

Compose 文件把容器内 viewer 的监听地址固定为 `0.0.0.0`，这样 Docker 才能发布 viewer 端口。不要把 `AGENTMEMORY_VIEWER_HOST` 当成运维侧配置项；外部访问范围应通过 `ports` 映射和 `VIEWER_ALLOWED_HOSTS` 控制。

如果通过其他主机名、IP 或反向代理暴露 viewer，需要把实际进入的 Host header 精确加入 `.env` 中的 `VIEWER_ALLOWED_HOSTS`。

## 快速开始

```bash
cd support-files/agentmemory/docker-compose
cp .env.example .env
$EDITOR .env
docker compose up -d --build
```

服务启动成功后读取生成的 bearer secret（不要分享或写入日志）：

```bash
docker compose exec agentmemory cat /data/secret
```

secret 保存在数据卷内，新版不再将它打印到启动日志。首次启动需要联网下载固定版本的 state/http worker，下载缓存保存在数据卷内。

验证 API：

```bash
curl -fsS http://127.0.0.1:3111/agentmemory/livez
```

在同一台宿主机打开 dashboard：

```text
http://127.0.0.1:3113
```

## 从 0.9.30 升级

新版使用 [官方 Worker Compose 运行方式](https://agent-memory.dev/docs/deployment.md#docker)，不再生成或加载旧 `iii-config.yaml`，也不再使用 3112 端口。保持当前 Compose project 名称及 `agentmemory-data` 数据卷不变。

先构建镜像，再停止旧实例、离线备份完整数据卷，最后启动新版：

```bash
docker compose build
docker compose stop agentmemory
mkdir -p backups
chmod 700 backups
docker compose run --rm --no-deps --entrypoint tar agentmemory -C /data -czf - . > "backups/agentmemory-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3111/agentmemory/livez
```

确认备份命令成功后再启动新版。备份包含凭据及全部记忆，应私密保存。不要执行 `docker compose down -v`，不要让两个实例同时访问同一数据卷。

- `/data/state_store.db` 原位保留，索引、快照等目录也留在原卷中。
- 若 `/data/secret` 尚不存在，入口会把旧 `/data/.hmac` 复制为 `/data/secret` 并设置 `0600` 权限；保留旧文件及原 secret，现有客户端无需换密钥。
- 数据目录权限仅在首次迁移时递归调整，后续启动使用迁移标记避免重复遍历。
- 新版运行日志及 Worker Compose 缓存也在 `/data`；首次启动可能需要等待 worker 下载完成。
- 如需回滚，先停止新版，用旧版配置和镜像恢复**升级前完整备份**。不要直接让旧 runtime 写入已被新版使用的数据卷。

自定义环境变量需要同时出现在 `docker-compose.yml` 和 `worker-compose.yaml` 的 agentmemory `environment` 中；Worker Compose 不会自动继承所有父进程变量。当前 worker 配置与官方部署一样固定使用 `/data`，不要单独把 `AGENTMEMORY_DATA_DIR` 改成其他路径。

## Agent 环境变量

需要接入这个服务的 agent 启动前设置：

```bash
export AGENTMEMORY_URL=http://127.0.0.1:3111
export AGENTMEMORY_SECRET='<value from /data/secret>'
```

如果 agent 运行在另一台机器上，通过 HTTPS 反向代理连接此服务，或使用 SSH 隧道；不要在不可信网络中通过明文 HTTP 发送 bearer secret。

这些变量属于本机 CLI/MCP shim 或 agent 进程，不属于服务容器配置，所以不放进 `.env.example`。需要诊断 agent 侧连接时，可在 agent 进程环境中临时设置 `AGENTMEMORY_DEBUG=1`、`AGENTMEMORY_FORCE_PROXY=1` 或 `AGENTMEMORY_PROBE_TIMEOUT_MS=2000`。

## Embedding、Rerank 和图抽取

embedding 模型和维度是本机运维选择，不应在 `docker-compose.yml` 里隐式写死默认值。使用 OpenAI-compatible embedding endpoint 时，在 `.env` 中显式设置，例如 `.env.example` 当前给出的本地默认值：

```text
EMBEDDING_PROVIDER=openai
OPENAI_EMBEDDING_MODEL=Qwen3-Embedding-8B
OPENAI_EMBEDDING_DIMENSIONS=4096
```

这些 `OPENAI_EMBEDDING_*` 变量只在 `EMBEDDING_PROVIDER=openai` 时生效；如果改用 Voyage 这类非 OpenAI embedding provider，应改 `EMBEDDING_PROVIDER` 并填写对应 provider token。

只有在 LLM-compatible provider 已配置可用后，才在 `.env` 中启用 compression、context injection 和 graph extraction。

agentmemory 当前只通过 `RERANK_ENABLED=true` 暴露一个可选的本地 rerank 步骤。这个 Compose stack 没有外部 reranker 模型配置点，所以不要把 `Qwen3-Reranker-8B` 加到这里；除非上游 agentmemory 增加明确支持的模型或配置变量。

## 高级配置

`.env.example` 同时作为本 Compose stack 的配置索引：常用项保持未注释，高级调优项默认注释，需要时再取消注释并填写。`docker-compose.yml` 直接使用官方变量名，并通过 `${VAR:-default}` 保留本地默认值能力；复制 `.env.example` 为 `.env` 后，Compose 会自动读取 `.env` 并覆盖这些默认值。

搜索和上下文注入相关变量包括 `BM25_WEIGHT`、`VECTOR_WEIGHT`、`AGENTMEMORY_GRAPH_WEIGHT`、`TOKEN_BUDGET`、`MAX_OBS_PER_SESSION`、`SUMMARIZE_CHUNK_SIZE` 和 `SUMMARIZE_CHUNK_CONCURRENCY`。这些变量会直接影响 recall 排名、context 注入大小、单会话观测上限和 summarize 分块行为，除非有明确问题，否则优先使用上游默认值。

行为开关包括 `AGENTMEMORY_AUTO_COMPRESS`、`AGENTMEMORY_INJECT_CONTEXT`、`CONSOLIDATION_ENABLED`、`CONSOLIDATION_DECAY_DAYS`、`GRAPH_EXTRACTION_ENABLED`、`GRAPH_EXTRACTION_BATCH_SIZE`、`AGENTMEMORY_LLM_NOTHINK`、`AGENTMEMORY_REFLECT`、`AGENTMEMORY_DROP_STALE_INDEX` 和 `AGENTMEMORY_IMAGE_EMBEDDINGS`。

命令行和运行时变量要区分服务容器和 agent 进程：`AGENTMEMORY_DATA_DIR`、`AGENTMEMORY_EXPORT_ROOT`、`SNAPSHOT_ENABLED`、`SNAPSHOT_DIR`、`SNAPSHOT_INTERVAL`、`TEAM_MODE`、`TEAM_ID`、`USER_ID` 属于服务容器运行配置；`AGENTMEMORY_URL`、`AGENTMEMORY_DEBUG`、`AGENTMEMORY_FORCE_PROXY`、`AGENTMEMORY_PROBE_TIMEOUT_MS`、`STANDALONE_MCP`、`STANDALONE_PERSIST_PATH` 主要给本机 CLI/MCP shim 或 agent 进程使用，只在本 README 说明，不放进服务容器的 `.env.example`。
