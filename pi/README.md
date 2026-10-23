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
| `pi/mcp-adapter.json`                         | `mcp-adapter.json`                            | 软链接                                          |
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

使用 `pi-mcp-adapter`，在 settings 中通过 `-builtin:mcp` 禁用 built-in MCP，避免重复加载。MCP 定义包含 codegraph、sequential-thinking、exa、context7、deepwiki、gh_grep、mise、agentmemory；agentmemory 的变量由 adapter 在运行时解析。

MCP 服务在 `pi/mcp-adapter.json` 中配置。进入 Pi 后用 `/mcp-adapter` 查看实际连接；native `pi mcp list` 不代表这套 adapter 配置的状态。

三个本地扩展分别负责 agentmemory 事件捕获、全局规则提醒、任务 skill 加载后的 memory recall 提醒。

## 子代理模型分工

使用 `pi-subagents@0.80.0` 的内置角色，通过 `pi/settings.json` 的 `subagents.agentOverrides` 指定模型与思考等级。

| 子代理             | 模型             | 思考等级 | 任务                                     |
| ------------------ | ---------------- | -------- | ---------------------------------------- |
| `scout`            | `openai/luna-6`  | `low`    | 定位文件、入口与调用链，输出紧凑上下文   |
| `researcher`       | `openai/luna-6`  | `medium` | 检索文档、整理资料和来源                 |
| `evidence-auditor` | `openai/sol-6.1` | `high`   | 独立核对研究结论与证据                   |
| `worker`           | `openai/sol-6.1` | `high`   | 实现、修复及验证                         |
| `reviewer`         | `openai/sol-6.1` | `high`   | 检查正确性、并发、资源生命周期和测试覆盖 |
| `oracle`           | `openai/sol-6.1` | `xhigh`  | 复杂故障推理、架构权衡与方案质疑         |
| `delegate`         | `openai/astra-6` | `low`    | 通用、范围明确的委派任务                 |

这些角色不再随主会话切换模型；单次调用和项目配置仍可覆盖。其他自定义角色及外部 CLI agent 不在此分工范围内，按各自的模型解析规则执行。`oracle` 的较高思考等级可能增加耗时和输出用量，宜用于目标明确的复杂问题。

配置只指定模型与思考等级，不改变角色提示词、工具权限或扩展加载。`researcher` 和 `evidence-auditor` 仍要求子会话加载 `pi-web-access`；安装在主会话中不代表前台子会话也已加载。进入 Pi 后可用 `/subagents-doctor` 检查环境，并显式要求相应角色执行任务。

参考：[pi-subagents models](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md)。

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
| `interactive_bash` / `mise_*` | 询问；`mcp` 规则还匹配 `mise_*`、`mise:*`，覆盖 MCP proxy 和直接工具名调用                     |
| `external_directory`          | 默认询问；临时目录、部分配置/cache 和 skills 目录有例外，具体路径见策略文件；Pi 目录不自动豁免 |
| 未覆盖的工具 `*`              | 默认允许，包含普通 MCP、skills 和 `ls`；不是所有工具默认询问                                   |

`git clean -fd *` 保持询问，`git clean -fdx *`、`git clean -fxd *`、`git clean -dfx *` 保持拒绝。`.env.example` 不另行放行：它仍命中原有 `*.env.*` 拒绝规则。策略不增加跨工具的全局 `path` 拒绝，避免把文件工具限制扩大到所有 shell 和 MCP 调用。`yoloMode` 关闭，不自动批准询问。

**权限行为与边界：**

- `find`、`grep` 的规则匹配 `input.path`。例如在 `.` 中搜索 `*.env`，不会因搜索表达式命中 `*.env` 拒绝；也不会逐个过滤搜索结果。相反，搜索路径含 `secret` 会命中路径拒绝，即使搜索表达式不含该词。搜索路径限制不能替代搜索结果过滤。
- Pi 还会检查路径的规范化/符号链接别名，并对 shell 中识别出的文件访问执行目录边界检查；同一调用可能比单独的命令规则多一次询问。链式命令按子命令取最严格结果；`xargs`、`find -exec` 等包装执行即使命中允许规则，也可能被插件强制提升为询问。仅修改配置不能消除这些内置行为。
- 工具名规则只约束实际向插件暴露的工具调用；不能把外层代理、脚本或 subagent 内部的调用视为已逐项审批。`mise_*` 的映射不等于对任意批量执行器内部的 mise 调用都完成检查。
