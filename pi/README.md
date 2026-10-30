# Pi 配置

将本仓库维护的 Pi 配置部署到 `~/.pi/agent`；模型名称与参数适用于个人代理服务，使用其他服务时请修改 `pi/models.json` 和 `pi/settings.json`。

## 快速开始

工具链参考仓库根 `mise.toml`。

在仓库根目录操作；部署前退出 Pi，避免配置写入冲突：

```bash
# 必须 export，使部署脚本及随后启动的 Pi 能继承变量。
# 使用你的实际 API 根地址，保留服务要求的路径，例如 /v1。
export ANTHROPIC_BASE_URL='https://your-proxy.example/anthropic/v1'
export OPENAI_BASE_URL='https://your-proxy.example/v1'

# 从你自己的凭据管理方式注入，不要把真实密钥提交到仓库。
export ANTHROPIC_AUTH_TOKEN='your-anthropic-token'
export OPENAI_AUTH_TOKEN='your-openai-token'
export AGENTMEMORY_URL='http://localhost:3111'
export AGENTMEMORY_SECRET='your-agentmemory-secret'
export CONTEXT7_API_KEY='your-context7-key'

./pi.sh link
./pi.sh diff
pi update --extensions
pi list
pi
```

`link` 只要求两个 base URL，不要求提供 API key；启动 Pi 时才需要 key。URL 必须是完整 HTTP(S) 地址，不允许包含用户名、密码、query 或 fragment，避免将凭据写入生成文件。

`packages` 中缺失或版本不匹配的 npm 包会在正常联网启动 Pi 时自动安装; `pi update --extensions` 用于显式协调包安装和更新，不是每次启动的必需步骤。npm 包固定版本，SoL-Pi 使用 latest。修改固定版本后，重新 `./pi.sh link` 并启动 Pi。

## 命令与目标目录

| 命令             | 行为                                                    |
| ---------------- | ------------------------------------------------------- |
| `./pi.sh link`   | 预检、备份冲突、链接静态资源、渲染并复制本机 JSON       |
| `./pi.sh diff`   | 只读检查链接与受管配置；退出码 0 相同、1 有差异、2 错误 |
| `./pi.sh --help` | 显示使用说明                                            |

目标目录优先级为 `TARGET_DIR` > `PI_CODING_AGENT_DIR` > `~/.pi/agent`。例如先在隔离目录检查部署：

```bash
TARGET_DIR="$HOME/.pi-preview/agent" ./pi.sh link
TARGET_DIR="$HOME/.pi-preview/agent" ./pi.sh diff
```

`TARGET_DIR` 只控制部署脚本，不控制 Pi。要让 Pi 使用另一个目录，在部署、安装包及启动时统一设置 `PI_CODING_AGENT_DIR`：

```bash
export PI_CODING_AGENT_DIR="$HOME/.pi-preview/agent"
./pi.sh link
pi update --extensions
pi
```

## 文件如何部署

| 仓库源                                        | 目标                                          | 方式                                            |
| --------------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| 根 `AGENTS.md`、`AGENTS-compression-guide.md` | agent 目录同名文件                            | 软链接，共享全局规则                            |
| `pi/mcp.json`                                 | `mcp.json`                                    | 软链接                                          |
| `pi/sol-pi.json`                              | `sol-pi.json`                                 | 软链接                                          |
| `pi/prompts/*.md`                             | `prompts/` 中对应文件                         | 逐文件软链接                                    |
| `pi/extensions/*/`                            | `extensions/` 中对应目录                      | 逐扩展目录软链接                                |
| `pi/models.json`                              | `models.json`                                 | 仅渲染 base URL，复制为普通文件，**不是软链接** |
| `pi/settings.json`                            | `settings.json`                               | 与本机配置合并后复制为普通文件                  |
| `pi/pi-permission-system.json`                | `extensions/pi-permission-system/config.json` | 逐文件软链接，目录及运行状态保留在本机          |

`settings.json` 中仓库声明的顶层字段由仓库管理；再次 `link` 会覆盖这些字段，数组整体替换。未声明的本机字段会保留，包括 Pi 写回的 `deviceId`、`lastChangelogVersion` 等。`/settings` 或包管理命令修改了受管字段后，需要把希望长期保留的改动同步到仓库，否则下次部署会恢复仓库值。

`models.json` 是完整受管文件，不保留目标文件中自行添加的 provider；修改模型应编辑仓库模板，再重新运行 `link`。模板内容变化不会自动传播到已生成文件。

## base URL 与 API key

模型 provider 定义在 `pi/models.json` 的 `providers` 中，使用 `baseUrl`、`apiKey`、`api` 字段。Pi 不对 `baseUrl` 做环境变量插值，因此由 `./pi.sh link` 渲染地址；更改地址后需重新部署并重启 Pi。

脚本只将模板中的两家 `baseUrl` 替换为 `ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL` 的值。

## MCP、skills 与扩展

使用 Pi 原生 MCP，服务在 `pi/mcp.json` 中配置，包含 codegraph、sequential-thinking、exa、context7、deepwiki、gh_grep、mise、agentmemory；agentmemory 的 `${AGENTMEMORY_URL}`、`${AGENTMEMORY_SECRET}` 与 context7 的 `${CONTEXT7_API_KEY}` 由 Pi 在运行时解析，不写入凭据值。context7 在 `env` 中声明密钥，与 OpenCode 的 `{env:CONTEXT7_API_KEY}` 一致：变量缺失时该服务直接连接失败，而不是带着空密钥静默降级。

所有服务使用 `deferred` 暴露模式：启动时后台连接，工具经 `tool_search` 发现后直接调用，不预先将全部工具定义放入模型上下文。进入 Pi 后用 `/mcp` 查看连接、工具和暴露模式；命令行用 `pi mcp list` 或 `pi mcp list --json` 检查。

参考：[Pi MCP](https://pi.dev/docs/latest/mcp)。

三个本地扩展分别负责 agentmemory 事件捕获、任务 skill 加载后的 memory-activation 提醒，以及 sequential-thinking 使用提醒。

- `agentmemory-capture`：把会话、prompt、tool 调用与结果、reasoning、配置和权限裁决写入 agentmemory；`/session-end` 结束采集并触发记忆整理。
- `memory-activation-reminder`：加载任务 skill 后提醒加载/应用 `memory-activation`；recall 工具调用本身不触发警告，也不清除待提醒状态。成功读取或通过 `/skill:memory-activation` 加载该 skill 后清除状态。
- `sequential-thinking-reminder`：累计每 2 个未配对的非空 thinking 片段，在下一次模型请求前注入提醒并显示通知；成功调用 sequential-thinking 后重置，失败不重置。使用 Pi 的最终消息事件计数，不重复统计流式增量；模型不输出 thinking 时不计数。

不移植 OpenCode 的 `agents-md-reminder`：Pi 每轮请求已在 system prompt 中带上全局 `AGENTS.md`（`pi.sh link` 链接到 agent 目录），再周期性复读同一句话只会增加噪音。

从早期版本升级时，`~/.pi/agent/extensions/agents-md-reminder` 是一条指向已删除源码的软链接。`pi.sh` 只管理仓库中仍存在的扩展，不会清理它；Pi 会忽略这个失效链接，但建议手动删除：

```bash
rm ~/.pi/agent/extensions/agents-md-reminder
```

`memory-activation-reminder`、`sequential-thinking-reminder` 两个提醒扩展的计数与待提醒状态按会话隔离：Pi 切换、fork、resume 会话时不会重载扩展，因此状态以会话 ID 为键，并在 `session_shutdown` 清理。`agentmemory-capture` 通过 `pi.events` 订阅 `permissions:ui_prompt` 和 `permissions:decision`，把用户可见的权限请求记录为 `notification`、把对应裁决记录为 `permission_replied`（含 `resolution`、`origin`、`matched_pattern`）；策略直接裁决、没有弹窗的请求只在异常结果（`gate_error`、`confirmation_unavailable`、`authorizer_denied`）时记录，避免每个工具调用都写一条。

新增扩展目录后需重新运行 `./pi.sh link` 并重启 Pi；已有扩展目录通过软链接同步源码。

### 扩展测试

扩展的 hook 行为由 `tests/pi-*.test.ts` 覆盖，使用 Node 内置 test runner 与 `node:assert`，无需安装依赖：扩展只从宿主包导入类型，运行时只用 Node 内置模块。

```bash
node --test tests/pi-*.test.ts
```

测试文件导入扩展源码时显式写出 `.ts` 扩展名，这是 Node ESM 解析的要求（Bun 允许省略）；`.ts` 直接执行依赖 Node 的类型剥离，Node 22.18+ 与 24 LTS 起默认开启，不需要 `--experimental-strip-types`。

`tests/pi-harness.ts` 模拟 Pi 的宿主契约：`ExtensionAPI` 的 `on`/`events.on`/`appendEntry`/`registerCommand`/`getSettings`/`getMcpServers`/`getCommands`，以及每次 hook 收到的 `ExtensionContext`（`sessionManager.getSessionId()`、`cwd`、`hasUI`、`ui.notify`）。hook 返回值按 Pi 的链式语义传给下一个 handler，`context_with_system` 返回的 `messages` 即被替换的完整数组。测试直接导入 `pi/extensions/*/index.ts` 真实源码，不复制实现。

覆盖范围：

- `pi-agentmemory-capture.test.ts`：`session/start` 载荷、`config_loaded`、prompt 与图片摘要、tool 输入/输出与 duration、结构化结果优先、重复 `tool_execution_end` 去重、空记忆搜索结果过滤、dispatcher 目标解析、reasoning 与错误消息、一次性注入与文件 `enrich`、`/context` 回退、system 内容为数组时的合并、`/summarize` 触发、`/session-end` 结束与幂等、shutdown 不结束、权限 prompt 与决策关联、无 prompt 决策只记异常、子会话归属，以及服务不可达时不打断 hook。
- `pi-memory-activation-reminder.test.ts`：读取已发现 skill 后的一次性注入、非 skill 文件与失败读取不算、memory 类 skill 不建 pending、读取 `memory-activation` 清除 pending、action tool 只警告一次、recall/MCP dispatcher/codemode 豁免、会话隔离、`/skill:` 展开识别、伪造 location 被拒、后续任务 skill 覆盖 pending、无 UI 时仍写日志、shutdown 与重新 `session_start` 清理。
- `pi-sequential-thinking-reminder.test.ts`：首轮 active 通知只发一次、每 2 个非空 thinking 提醒、空 thinking 与 user 消息不计数、会话隔离、成功调用后重置、dispatcher 管理动作与失败/错误结果不重置、逐级升级、无 UI 仍注入、shutdown 清理。

`pi/extensions/agentmemory-capture` 的扩展源码通过 `pi.events` 订阅权限事件，测试用 `emitBus` 直接派发同名事件；HTTP 请求被替换为记录型 `fetch`，断言落在请求路径和 body 上。

## 手动切换模型

使用 `/model` 选择当前会话模型，不启用子代理。可选模型及各模型的思考等级仍由 `pi/settings.json` 中的 `enabledModels`、`modelThinkingLevels` 维护。

## SoL-Pi：配置

`pi/sol-pi.json` 仅开启 ObservationPack。

| 机制                        | 当前设置与行为                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ObservationPack             | 开启；将符合条件的大型文本工具结果归档为稳定句柄，通过 `obs_recall` 精确分页召回，可用于构建、测试和排障中的长输出 |
| Action Fusion               | 关闭；编辑与后续验证命令仍分开调用，不引入编辑工具内嵌 shell 执行                                                  |
| Evidence-Preserving Reducer | 关闭；不额外调用 reducer 模型处理诊断日志；正常 Pi 模型请求不受此开关影响                                          |
| Online Context Compact      | 关闭；不增加 SoL-Pi 的计划边界自动压缩，Pi 原生压缩保持现有设置                                                    |

`./pi.sh link` 将配置链接到 agent 目录的 `sol-pi.json`；修改仓库文件后重启 Pi 生效。

参考：[SoL-Pi configuration](https://github.com/NVlabs/SoL-Pi/blob/main/docs/configuration.md)、[Security](https://github.com/NVlabs/SoL-Pi/blob/main/SECURITY.md)。

## 权限策略

使用 `@gotgenes/pi-permission-system@41.0.0`；插件由 Pi 在启动时安装和加载。

权限规则在 `pi/pi-permission-system.json` 中维护，最后匹配的规则优先。

| 工具或范围                    | 行为                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `bash`                        | 默认询问；配置了 Git、gh、gcx、Docker、kubectl、Helm 等命令的允许、询问或拒绝规则              |
| `read`                        | 普通读取允许；环境文件、密钥、凭据等敏感路径按规则拒绝                                         |
| `find` / `grep`               | 按搜索路径匹配各自的限制模式，而非搜索表达式                                                   |
| `edit` / `write`              | 使用相同规则；默认询问，部分配置路径允许，敏感路径拒绝；具体例外见策略文件                     |
| `interactive_bash` / `mise_*` | 询问；原生 `mcp__mise__*` 工具映射到 `mcp` 权限面，匹配 `mise_*`、`mise:*` 规则                |
| `external_directory`          | 默认询问；临时目录、部分配置/cache 和 skills 目录有例外，具体路径见策略文件；Pi 目录不自动豁免 |
| 未覆盖的工具 `*`              | 默认允许，包含普通 MCP、skills 和 `ls`；不是所有工具默认询问                                   |

`git clean -fd *` 保持询问，`git clean -fdx *`、`git clean -fxd *`、`git clean -dfx *` 保持拒绝。`.env.example` 不另行放行：它仍命中原有 `*.env.*` 拒绝规则。策略不增加跨工具的全局 `path` 拒绝，避免把文件工具限制扩大到所有 shell 和 MCP 调用。`yoloMode` 关闭，不自动批准询问。

OpenCode 的 `permission-audit` 插件没有对应扩展：`pi-permission-system` 的 `permissionReviewLog`（默认开启）已把请求与裁决写入 `extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl`，再写一份会造成重复审计。

**权限行为与边界：**

- `find`、`grep` 的规则匹配 `input.path`。例如在 `.` 中搜索 `*.env`，不会因搜索表达式命中 `*.env` 拒绝；也不会逐个过滤搜索结果。相反，搜索路径含 `secret` 会命中路径拒绝，即使搜索表达式不含该词。搜索路径限制不能替代搜索结果过滤。
- Pi 还会检查路径的规范化/符号链接别名，并对 shell 中识别出的文件访问执行目录边界检查；同一调用可能比单独的命令规则多一次询问。链式命令按子命令取最严格结果；`xargs`、`find -exec` 等包装执行即使命中允许规则，也可能被插件强制提升为询问。仅修改配置不能消除这些内置行为。
- 工具名规则只约束实际向插件暴露的工具调用；不能把外层代理或脚本内部的操作视为已逐项审批。`mise_*` 的映射不等于对任意批量执行器内部的 mise 调用都完成检查。
