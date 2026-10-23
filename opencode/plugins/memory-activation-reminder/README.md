# Memory Activation Reminder Hook

## 读者与目的

本文档面向维护 OpenCode hook 的 agents 和维护者。阅读它可以理解这个 hook 负责什么、不负责什么，以及如何避免 `memory-activation` 提醒循环。

## 职责边界

这个 hook 是一个软提醒机制。它不会自动运行 memory tools，不会阻塞工具执行，也不会复制 `memory-activation` skill 的工作流。它只负责发现 action-oriented skill 已加载，并向 agent 注入一次可见的 system reminder，提醒 agent 在行动前加载或应用 `memory-activation`。

`memory-activation` skill 负责真正的 recall workflow：如何构造 query、何时 retry、何时 smart-search、如何 adopt、ignore 或 defer memory 结果。

## 决策树

```mermaid
flowchart TD
    SkillEvent([session.skill.activated / execute.after]) --> SkillName[Extract skill ID]

    SkillName --> IsActivation{skill == memory-activation?}
    IsActivation -->|Yes| Clear[Clear pending activation]
    IsActivation -->|No| SkipSkill{Memory/reference/explanatory skill?}
    SkipSkill -->|Yes| IgnoreSkill
    SkipSkill -->|No| MarkPending[Mark pending task skill for session]

    SystemEvent([session.hook context]) --> PendingSystem{Pending task skill exists?}
    PendingSystem -->|No| IgnoreSystem[Ignore system transform]
    PendingSystem -->|Yes| AlreadyInjected{Already injected?}
    AlreadyInjected -->|Yes| IgnoreSystem
    AlreadyInjected -->|No| Inject[Append one-shot system reminder]

    ActionEvent([tool.execute.before]) --> PendingBefore{Pending task skill exists?}
    PendingBefore -->|No| IgnoreAction[Ignore action]
    PendingBefore -->|Yes| NonAction{Tool is non-action?}
    NonAction -->|Yes| IgnoreAction
    NonAction -->|No| AlreadyReminded{Already reminded?}
    AlreadyReminded -->|Yes| IgnoreAction
    AlreadyReminded -->|No| Toast[Emit RPC reminder and write server log]
    Toast --> CLI[CLI plugin shows warning toast]
```

## 状态模型

状态按 session 隔离：

```text
pendingBySession[sessionID] = {
  skill: string,
  injected: boolean,
  reminded: boolean
}
```

- 加载 `memory-activation` 会清除该 session 的 pending state。
- 加载 skiplist 中的 memory/reference skill 不会创建 pending state。
- 加载其它 skill 会创建 pending state。
- 下一次 `session.hook("context")` 会向 `event.system` 注入一次 agent-visible reminder。
- 下一次 non-action tool 会被忽略。
- 下一次 action tool 会发送 RPC event，由 CLI plugin 显示 human-visible toast，并写入 server log 备份提醒。
- 每次 pending skill load 最多注入一次 system reminder，也最多触发一次 toast/log reminder。
- RPC event 投递失败会记录错误，并允许下一个 action tool 重试；不会阻塞工具执行。

## Skip Lists

这些 skills 不受监督，因为它们本身管理 memory，或只是解释 reference material：

```text
memory-activation
agentmemory-mcp-tools
forget
lesson
memory-discipline
recall
recap
remember
session-history
```

这些 tools 在 toast/log reminder 触发前允许执行：

```text
skill
agentmemory_memory_lesson_recall
agentmemory_memory_recall
agentmemory_memory_smart_search
```

## Agent Reminder Text

hook 会向 `event.system` 追加一次这段文本：

```text
[Memory activation reminder]
You loaded task-specific/action skill "<skill>" but have not applied memory-activation yet. Before acting, load/apply memory-activation, or explicitly state why it is skipped for this task.
```

## Human And Log Reminder Text

服务端 hook 写入 log，并发送 `rpc.memory-activation-reminder.reminder` event。`tui.ts` 订阅同一 directory 的提醒，通过 V2 的 `context.ui.toast.show()` 显示 warning toast；提醒携带 session ID，方便定位来源：

```text
Loaded task skill "<skill>" without applying memory-activation. Load/apply memory-activation before acting, or state why it is skipped.
```

## 非目标

- 不自动运行 `memory_lesson_recall`。
- 不阻塞 `bash`、文件编辑或外部资源操作。
- 不判断 recall query 是否足够好。
- 不在 hook 中复制 `memory-activation` skill 的 workflow。
- 不把 `memory-activation` 当作 task skill；它必须清除 pending state。

## 已知限制

这个 MVP 通过 V2 的 `session.skill.activated` 事件和 `skill` 工具的 `execute.after` hook 识别 skill load，注入一次 agent-visible system reminder，并在下一个 action tool 前保留 toast/log 作为 human-visible 备份。它不能证明 agent 真的把 memory 采纳进计划；这仍然由 `memory-activation` skill 和全局 `Memory Activation` 规则负责。

V2 会自动加载插件目录中与 `index.ts` 并列的 `tui.ts`，不需要另行配置 `cli.json`。安装时必须保留整个目录，包括共享的 `rpc.ts`。已有 TUI 需要重新加载该插件或重启界面才能启用 CLI 入口。

RPC event 是实时通知，不会重放。没有连接的 TUI，或 TUI 正在查看其它 directory 时不会显示 toast；服务端 log 和 agent-visible reminder 仍然保留。加载 `memory-activation` 后 pending state 已清除，因此后续 action tool 不会显示提醒。
