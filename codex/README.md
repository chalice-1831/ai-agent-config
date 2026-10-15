# Codex 配置

这个目录维护 Codex 的共享 MCP 定义和全局命令规则。`codex.sh` 负责把规则链接到本机，并将共享 MCP 定义同步到本机配置；模型、provider、项目授权、插件和其他本机设置不由它管理。

## 安装与检查

在仓库根目录运行：

```bash
./codex.sh link
./codex.sh sync
./codex.sh diff
```

`link` 会逐文件链接 `AGENTS.md`、`AGENTS-compression-guide.md` 和 `codex/rules/*.rules`，遇到冲突文件会先备份。`sync` 只处理共享 MCP 定义；它会检查启用的本地 MCP 命令是否在 `PATH` 中，但不会启动服务。`diff` 返回 0 表示一致，1 表示有差异或冲突，2 表示出错。正确链接及一致的配置重复执行时不会重写。

脚本可以从任意目录运行。目标目录优先取 `TARGET_DIR`，其次是 `CODEX_HOME`，默认是 `~/.codex`。需要 Bash 和 `uv`；MCP 辅助脚本通过 `uv` 隔离运行 TOMLKit 0.15.1，首次使用可能需要联网下载依赖。

## AgentMemory

共享配置通过 `@agentmemory/mcp` 连接 AgentMemory，不再保留旧的 `memory` MCP。本机启动 Codex 前，设置 `AGENTMEMORY_URL` 和 `AGENTMEMORY_SECRET` 环境变量；仓库只记录变量名，不保存服务地址或密钥。

同步后重启 Codex，让规则和 MCP 配置生效。可以先用 `codex mcp list` 检查服务是否列出，再调用一个 AgentMemory 只读工具确认远端确实可用。仅看到服务或存活检查成功，不代表每个工具都正常。

## 冲突、备份与本机配置

上次同步的定义保存在本机 `.config-sync/mcp.toml`，不要提交或编辑这个文件来绕过冲突。如果同名 MCP 在本机的定义与共享定义不同，且不是上次同步的版本，`sync` 会停止，不会自动覆盖，也不会把可能含凭据的配置值打印出来。请手动比较本机 `config.toml` 和仓库 `codex/mcp.toml`：选择共享定义后再同步，或者保留本机定制并接受 `diff` 报告冲突。

仓库删除某个共享 MCP 时，脚本只报告 `STALE`，不会删除本机服务；确认不再需要后，再手动删除本机对应条目并重新同步。本机的 `config.toml` 必须是普通文件，不能是软链接；检测到并发修改时，脚本会停止。同步期间不要让其他客户端编辑它。

需要手动留档时运行 `./codex.sh backup`。快照位于目标目录的 `backups/codex.*` 下，保留原目录结构，可以按路径复制回来。如果脚本异常中断并留下 `.config-sync/lock`，先确认没有安装任务在运行，再移除残留的空锁目录。

`codex/rules/*.rules` 只用于全局规则，项目规则仍放在项目的 `.codex/rules/`，安装脚本不会把它们推广到全局。本机的 `rules/default.rules`、认证信息、会话、缓存及其他非受管文件都不会被替换。整理旧规则时，只归档逐条核实过的条目；脚本不会按名称猜测或批量删除。安装完成不等于远程服务已验证可用。
