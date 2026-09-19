|安装:./codex.sh link|逐文件链接 AGENTS.md、AGENTS-compression-guide.md、rules/*.rules；冲突文件先备份
|同步:./codex.sh sync|只更新共享 MCP；保留模型、provider、项目授权、插件和其他机器配置
|检查:./codex.sh diff|退出码 0=一致，1=差异或冲突，2=错误
|备份:./codex.sh backup|快照保存在目标 backups/codex.*；保留原目录结构，可将快照中的文件复制回相应位置
|目标目录:TARGET_DIR 优先，其次 CODEX_HOME，最后 ~/.codex|脚本可从任意工作目录调用
|依赖:Bash、uv|MCP 辅助脚本隔离运行 TOMLKit 0.15.1，首次运行需联网获取依赖
|MCP运行依赖:启用的本地 MCP command 必须能从 PATH 找到；sync 只检查命令存在，不启动服务
|本机状态:.config-sync/mcp.toml 保存上次同步定义|不要提交此文件；不修改它来强行绕过冲突
|冲突:同名本地定义与共享定义不同且不等于上次同步内容时停止；不打印可能含凭据的配置值
|冲突处理:手动比较本机 config.toml 与共享 mcp.toml；选择共享值后重跑 sync，或保留本机定制并接受 diff 报告
|删除:仓库移除的 MCP 仅报告 STALE，保留本机服务；确认后手动删除本机对应条目，再运行 sync
|保护:config.toml 必须是本地文件；不通过软链接写入另一份配置|检测到并发修改时停止；同步期间避免其他客户端编辑配置
|重复执行:正确链接及一致配置不重写；同步状态用于区分公共更新和机器定制
|锁:.config-sync/lock 防止本脚本并发写入；异常中止后确认无安装任务运行，再手动移除残留空锁目录
|作用域:codex/rules/*.rules 仅为全局规则；项目规则在 .codex/rules/，不由安装脚本推广到全局
|本机保留:rules/default.rules、认证、会话、缓存与其他非受管文件不替换
|旧规则:首次整理仅归档经逐条核实的旧规则；安装脚本不按名称猜测或批量删除非受管文件
|生效:重启 Codex 加载规则与 MCP；安装不代表已验证远程服务连接
