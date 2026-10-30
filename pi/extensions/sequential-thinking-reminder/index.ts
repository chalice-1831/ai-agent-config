import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const THOUGHT_REMINDER_INTERVAL = 2;
const SERVER = "sequential-thinking";
const TOOL = "sequentialthinking";

type SessionState = {
  unpairedThoughts: number;
  reminderLevel: number;
  nextReminderAt: number;
  activeEmitted: boolean;
};

function freshState(): SessionState {
  return {
    unpairedThoughts: 0,
    reminderLevel: 0,
    nextReminderAt: THOUGHT_REMINDER_INTERVAL,
    activeEmitted: false,
  };
}

function isThinkingTool(tool: string, server?: unknown): boolean {
  if (server !== undefined && server !== SERVER) return false;
  const normalized = tool.replace(/-/g, "_");
  return normalized === TOOL || normalized === `sequential_thinking_${TOOL}` ||
    normalized === `mcp__sequential_thinking__${TOOL}`;
}

function isThinkingCall(tool: string, input: Record<string, unknown>): boolean {
  if (tool === "mcp") {
    return !input.action && typeof input.tool === "string" && isThinkingTool(input.tool, input.server);
  }
  if (tool.replace(/-/g, "_") === "mcp__sequential_thinking") {
    return typeof input.tool === "string" && isThinkingTool(input.tool, SERVER);
  }
  return isThinkingTool(tool);
}

export default function sequentialThinkingReminder(pi: ExtensionAPI) {
  // Counters are per session so a resumed, forked or replaced session cannot
  // inherit another session's thought count, matching the OpenCode plugin.
  const states = new Map<string, SessionState>();

  function stateFor(ctx: ExtensionContext): SessionState {
    const sid = ctx.sessionManager.getSessionId();
    let state = states.get(sid);
    if (!state) {
      state = freshState();
      states.set(sid, state);
    }
    return state;
  }

  function reset(state: SessionState) {
    state.unpairedThoughts = 0;
    state.reminderLevel = 0;
    state.nextReminderAt = THOUGHT_REMINDER_INTERVAL;
  }

  pi.on("session_start", (_event, ctx) => {
    states.set(ctx.sessionManager.getSessionId(), freshState());
  });

  pi.on("session_shutdown", (_event, ctx) => {
    states.delete(ctx.sessionManager.getSessionId());
  });

  // Count finalized nonempty parts once, never streaming deltas or old history.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    for (const part of event.message.content) {
      if (part.type === "thinking" && part.thinking.trim()) stateFor(ctx).unpairedThoughts += 1;
    }
  });

  // Nested codemode calls use the same hooks; only an actual successful target
  // call resets the counter, not the dispatcher or an MCP management action.
  pi.on("tool_result", (event, ctx) => {
    if (event.isError || !isThinkingCall(event.toolName, event.input)) return;
    // Adapter failures can be returned before its own hook sets isError.
    const details = event.details as Record<string, unknown> | undefined;
    const result = details?.mcpResult as { isError?: boolean } | undefined;
    if (details?.error || result?.isError) return;
    reset(stateFor(ctx));
    pi.appendEntry("sequential-thinking-reminder", { trigger: "successful_tool" });
  });

  pi.on("context_with_system", (event, ctx) => {
    const state = stateFor(ctx);
    if (!state.activeEmitted) {
      state.activeEmitted = true;
      const message = "Monitoring reasoning thoughts and sequential-thinking usage.";
      if (ctx.hasUI) ctx.ui.notify(message, "info");
      pi.appendEntry("sequential-thinking-reminder", { trigger: "active", message });
    }
    if (state.unpairedThoughts < state.nextReminderAt) return;
    state.reminderLevel += 1;
    state.nextReminderAt = state.unpairedThoughts + THOUGHT_REMINDER_INTERVAL;
    const message = `The agent has completed ${state.unpairedThoughts} reasoning thoughts without using the sequential-thinking tool. Use sequential-thinking before continuing.`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    pi.appendEntry("sequential-thinking-reminder", {
      trigger: "reminder", message, thoughtCount: state.unpairedThoughts, reminderLevel: state.reminderLevel,
    });
    return {
      messages: [...event.messages, {
        role: "system" as const,
        content: `[Sequential-thinking reminder]\n${message}`,
        timestamp: Date.now(),
      }],
    };
  });
}
