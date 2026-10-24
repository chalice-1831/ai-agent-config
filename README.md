## ai-agent-config

个人使用的 OpenCode 配置仓库，用来集中维护全局 agent 规则、OpenCode 配置、MCP 工具、插件和常用 skills 安装脚本。

这个仓库的目标不是做成通用发行版，而是把我自己的 AI 编程环境配置沉淀成可复用、可审计、可快速同步的版本化配置。其他人可以参考结构或 fork 后按自己的模型、密钥和工具链调整。

## 包含内容

```text
.
├── AGENTS.md                    # 全局 agent 行为约束，使用高密度 pipe-index 格式
├── AGENTS-compression-guide.md  # AGENTS.md 压缩格式与维护指南
├── mise.toml                    # 基础工具链：Go、LSP、Biome、ripgrep、jq、yq、gh、ast-grep 等
├── mise.sh                      # 将 mise.toml 链接到 mise 全局配置的脚本
├── opencode.sh                  # 将配置链接到 OpenCode 配置目录的脚本
├── codex.sh                     # 安装 Codex 规则并同步共享 MCP
├── codex/                       # 共享 MCP、命令规则及安装说明
├── opencode/
│   ├── opencode.jsonc           # OpenCode 主配置：providers、MCP、plugins、permissions、formatters
│   ├── dcp.jsonc                # Dynamic Context Pruning 配置
│   └── plugins/                 # 本地 OpenCode 插件
├── support-files/
│   └── agentmemory/docker-compose/ # agentmemory Docker Compose 运行模板
└── scripts/
    └── skills.sh                # 全局安装常用 OpenCode skills
```

## 快速开始

安装 `mise`：

```bash
curl https://mise.run | sh
```

安装本仓库声明的基础工具：

```bash
./mise.sh link
mise install
```

把配置链接到默认 OpenCode 配置目录 `~/.config/opencode`：

```bash
./opencode.sh link
```

检查目标目录中的配置是否与仓库一致：

```bash
./opencode.sh diff
```

|Codex:先运行 `./codex.sh link`，再运行 `./codex.sh sync`；用 `./codex.sh diff` 检查状态
|Codex文档:[多机器配置说明](codex/README.md)

安装常用 skills：

```bash
./scripts/skills.sh
```

## 安装脚本

`mise.sh` 默认把仓库根目录的 `mise.toml` 链接到 `~/.config/mise/config.toml`：

```bash
./mise.sh link
```

可通过环境变量调整目标目录：

```bash
TARGET_DIR=/path/to/mise-config ./mise.sh link
```

检查目标配置是否与仓库一致：

```bash
./mise.sh diff
```

`opencode.sh` 默认把这些文件以文件级符号链接链接到
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode`：

- `AGENTS.md`
- `AGENTS-compression-guide.md`
- `opencode/*.jsonc`
- `opencode/*.json`

脚本不会把整个 `${XDG_CONFIG_HOME:-$HOME/.config}/opencode` 目录替换成仓库目录，因此会保留 OpenCode 的
`logs/`、`node_modules/` 等本机运行时状态。`link` 会在替换已有本地文件前保存备份，
备份位于目标目录下的 `backups/opencode.*`。脚本可从任意工作目录调用，源文件始终按
`opencode.sh` 所在的仓库目录解析；`diff` 要求目标是指向本仓库的 managed symlink。

可通过环境变量调整目标目录：

```bash
TARGET_DIR=/path/to/opencode-config ./opencode.sh link
```

也可以追加额外文件：

```bash
EXTRA_FILES="extra.md another.jsonc" ./opencode.sh link
```

当前支持的命令：

```text
link    创建或更新符号链接；替换冲突文件前自动备份
diff    检查仓库配置对应的 managed symlink
backup  占位命令，尚未实现
```

## OpenCode 配置重点

`opencode/opencode.jsonc` 是主配置文件，使用官方 schema：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
}
```

当前配置重点包括：

- providers：配置 Anthropic 与 OpenAI 兼容 provider，并通过环境变量读取 base URL 和 token。
- models：维护主力模型、轻量模型、上下文窗口、输出限制和 reasoning / thinking variants。
- MCP：启用 `codegraph`、`sequential-thinking`、`exa`、`context7`、`deepwiki`、`gh_grep`、`mise`、`agentmemory` 等工具；`serena` 配置暂时保留但禁用，便于回滚。
- CodeGraph 负责当前代码结构、符号、调用边、路由和影响面查询；AgentMemory 负责历史会话、决策、偏好和 post-mortem 检索。处理历史 bug 时先查 AgentMemory，再用 CodeGraph 检查当前代码。
- CodeGraph CLI 由 `mise.toml` 安装；每个需要索引的项目仍需执行一次 `codegraph init` 建立本地 `.codegraph/` 索引。
- plugins：启用 tracing、AgentMemory、权限审计和 ACP 等插件。
- permissions：对常用只读命令放行，对破坏性 Git、Docker、Kubernetes、文件删除、密钥文件读写等操作设置 ask / deny。
- formatters：为 Go、Shell、Markdown / YAML 配置格式化命令。

OpenCode 权限审计插件仅记录弹出的权限申请及用户回复，包括原始 `pattern` 和项目根目录路径，不会自动修改权限白名单。记录按小时写入用户级 JSONL 文件，默认存放在 `~/.local/state/opencode/permission-audit/`（可通过 `XDG_STATE_HOME` 更改位置），文件权限为 `0600`。插件不会自动清理记录，旧文件需手动删除；写入失败时会记录错误，并在 TUI 可用时提示，不阻断审批。

### OpenCode 宿主 Trace（OTLP）

OpenCode 原生支持通过 OTLP/HTTP 导出宿主运行时的 trace。它不需要额外插件；使用已有的 OpenTelemetry Collector、Tempo 或其他兼容 OTLP/HTTP 的接收端即可。

设置 OTLP/HTTP 基础地址：

```bash
opencode service set env OTEL_EXPORTER_OTLP_ENDPOINT "<OTLP_HTTP_ENDPOINT>"
```

`<OTLP_HTTP_ENDPOINT>` 应填写接收端的基础 URL，不要附加 `/v1/traces`。OpenCode 会自动发送到：

- `<OTLP_HTTP_ENDPOINT>/v1/traces`
- `<OTLP_HTTP_ENDPOINT>/v1/logs`

如果接收端需要认证 header，可使用占位符配置，真实凭据不要写入仓库：

```bash
opencode service set env OTEL_EXPORTER_OTLP_HEADERS "<HEADER_NAME>=<HEADER_VALUE>"
```

设置 service 环境变量后，必须重启后台 server，确保新进程继承配置：

```bash
opencode service restart
```

验证配置和服务状态：

```bash
opencode service get env OTEL_EXPORTER_OTLP_ENDPOINT
opencode service status
```

然后在 trace 后端按 `service.name = "opencode"` 查询。只看到配置值并不代表已经导出成功，必须以接收端实际收到的 trace 为准。

设置该 endpoint 会同时启用 OTLP trace 和 OTLP logs；如果只需要宿主 trace，应在 Collector 或后端配置日志过滤、脱敏和保留策略。具体能看到哪些组件 span 取决于 OpenCode 版本和实际执行路径，接入成功不等于所有内部组件都已自动覆盖。

`opencode/dcp.jsonc` 维护 Dynamic Context Pruning 策略，用于控制上下文裁剪、压缩提醒、保护工具输出和错误清理。

## Support Files

`support-files/agentmemory/docker-compose/` 维护 agentmemory Docker Compose 运行模板，可供 OpenCode、Codex 或其他 agent 共用同一个 memory server。真实 `.env` 不进入仓库，按子目录 README 从 `.env.example` 复制后填写本机配置。

## 常用维护流程

更新工具链后：

```bash
mise install
```

修改配置后：

```bash
./mise.sh diff
./mise.sh link
./opencode.sh diff
./opencode.sh link
```

更新全局 skills：

```bash
./scripts/skills.sh
```

## 注意事项

- 这是个人配置仓库，不保证直接适配其他人的模型供应商、API 网关、MCP 环境或权限偏好。
- `opencode.jsonc` 中的 provider 使用环境变量读取凭据，不应把真实 token 写入仓库。
- `backup` 命令目前只是占位；需要备份时请先手动复制目标目录。
- OpenCode 配置支持 JSON / JSONC，并会合并 global、project、custom config 等多层配置；本仓库主要面向 global config 使用。
- OpenCode 默认从 `XDG_CONFIG_HOME/opencode`（未设置时为 `~/.config/opencode`）加载全局配置；除非明确设置 `OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG` 或 `OPENCODE_CONFIG_CONTENT`，否则不要用这些变量绕过本脚本管理的目录。
- MCP server 会增加上下文占用，启用过多工具时需要关注上下文窗口和响应成本。
