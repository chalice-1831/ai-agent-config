|组织:按命令职责维护；授权决策与全局/项目作用域分别管理
|全局目录:codex/rules→~/.codex/rules|仅安装下列11个全局规则文件
|通用命令:shell.rules|文件检索、文本处理、终端、HTTP 工具
|Go:go.rules|go、gofmt、golangci-lint
|Python:python.rules|python、pip list
|Node.js:nodejs.rules|npm list、pnpm run
|PHP:php.rules|php
|mise:mise.rules|mise ls
|OpenCode CLI:opencode-cli.rules|opencode --version、opencode models
|版本控制:git.rules|Git 查询与写操作，以及破坏性操作的拒绝例外
|GitHub:github.rules|查询、Issue 操作、PR create/edit/ready
|基础设施:infrastructure.rules|Docker、Kubernetes、Helm、Ansible
|Grafana:grafana.rules|gcx 查询与配置检查
|项目规则:.codex/rules/github.rules|仅限本项目的仓库定向 PR 创建规则，不安装到全局
|匹配:argv 字面前缀，允许追加参数|多条匹配取最严格决策 forbidden > prompt > allow
|边界:未匹配规则不代表禁止，继续由 Codex 审批策略判断|规则不替代具体任务授权
|PR合并:未加入免审批白名单|comment/checkout 待明确确认 --delete-last/--force 参数范围；未生成可安装规则
|审批保留:less、gh auth status、gh api、gcx config view 未加入本配置的免审批白名单
|宽泛授权:python、go、curl、xargs 等命令允许追加参数，并非只读保证
|Git拒绝:push 的 force/f/mirror/delete/d/all/tags/force-with-lease 前缀及 stash drop/clear|参数换序不保证命中
|独立规则:default.rules 由 Codex 管理，保留原状；既有 helm、gcx datasources 授权更宽
|验证:codex execpolicy check --rules codex/rules/git.rules -- git status --short|多个文件用重复 --rules 参数
|生效:重启 Codex 加载已安装规则
