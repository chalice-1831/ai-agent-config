## ai-agent-config

个人使用的 OpenCode / OhMyOpenCode 配置仓库，用来集中维护全局 agent 规则、OpenCode 配置、MCP 工具、插件和常用 skills 安装脚本。

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
│   ├── oh-my-openagent.jsonc    # OhMyOpenAgent agents / categories / fallback 配置
│   ├── dcp.jsonc                # Dynamic Context Pruning 配置
│   └── tui.json                 # TUI 插件配置
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

`opencode.sh` 默认把这些文件链接到 `~/.config/opencode`：

- `AGENTS.md`
- `AGENTS-compression-guide.md`
- `opencode/*.jsonc`
- `opencode/*.json`

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
link    创建或更新符号链接
diff    对比仓库配置和目标目录配置
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
- MCP：启用 `codegraph`、`sequential-thinking`、`exa`、`context7`、`memory`、`deepwiki`、`gh_grep`、`mise`、`agentmemory` 等工具；`serena` 配置暂时保留但禁用，便于回滚。
- CodeGraph 负责当前代码结构、符号、调用边、路由和影响面查询；AgentMemory 负责历史会话、决策、偏好和 post-mortem 检索。处理历史 bug 时先查 AgentMemory，再用 CodeGraph 检查当前代码。
- CodeGraph CLI 由 `mise.toml` 安装；每个需要索引的项目仍需执行一次 `codegraph init` 建立本地 `.codegraph/` 索引。
- plugins：启用 tracing、Markdown table formatter、DCP、OhMyOpenAgent。
- permissions：对常用只读命令放行，对破坏性 Git、Docker、Kubernetes、文件删除、密钥文件读写等操作设置 ask / deny。
- formatters：为 Go、Shell、Markdown / YAML 配置格式化命令。

`opencode/oh-my-openagent.jsonc` 维护 OhMyOpenAgent 的 agents 和 categories，例如编排、深度执行、咨询、检索、规划、评审、视觉工程、写作等角色，并配置模型与 fallback。

`opencode/dcp.jsonc` 维护 Dynamic Context Pruning 策略，用于控制上下文裁剪、压缩提醒、保护工具输出和错误清理。

`opencode/tui.json` 只加载 `oh-my-openagent/tui` 插件。

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
- MCP server 会增加上下文占用，启用过多工具时需要关注上下文窗口和响应成本。
