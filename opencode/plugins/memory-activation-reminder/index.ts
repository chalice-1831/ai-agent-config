import { Plugin } from "@opencode/plugin";

const ACTIVATION_SKILL = "memory-activation";

const SKIP_SKILLS = new Set([
  ACTIVATION_SKILL,
  "agentmemory-mcp-tools",
  "forget",
  "lesson",
  "memory-discipline",
  "recall",
  "recap",
  "remember",
  "session-history",
]);

const NON_ACTION_TOOLS = new Set([
  "skill",
  "agentmemory_memory_lesson_recall",
  "agentmemory_memory_recall",
  "agentmemory_memory_smart_search",
]);

type PendingActivation = {
  skill: string;
  injected: boolean;
  reminded: boolean;
};

function extractSkillName(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["name", "skill", "skillName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function sessionIdFrom(properties: Record<string, unknown>, part?: Record<string, unknown>): string {
  const value = part?.sessionID ?? properties.sessionID;
  return typeof value === "string" ? value : "";
}

function toolNameFrom(input: Record<string, unknown>): string {
  const tool = input.tool;
  return typeof tool === "string" ? tool : "";
}

export const MemoryActivationReminderPlugin = Plugin.define({
  id: "memory-activation-reminder",
  async setup(ctx) {
  const client = (ctx as any).client ?? ctx;
  const pendingBySession = new Map<string, PendingActivation>();
  let activeSessionId = "";

  async function remind(sessionID: string, pending: PendingActivation): Promise<void> {
    if (pending.reminded) return;
    pending.reminded = true;
    const message = `Loaded task skill "${pending.skill}" without applying ${ACTIVATION_SKILL}. Load/apply ${ACTIVATION_SKILL} before acting, or state why it is skipped.`;
    try {
      await client.tui.showToast({
        body: { title: "Memory activation", message, variant: "warning" },
      });
    } catch {}
    try {
      await client.app.log({ body: { service: "memory-activation-reminder", level: "warn", message, sessionID } });
    } catch {}
  }

  function handleSkill(sessionID: string, skillName: string): void {
    if (!sessionID || !skillName) return;
    if (skillName === ACTIVATION_SKILL) {
      pendingBySession.delete(sessionID);
      return;
    }
    if (SKIP_SKILLS.has(skillName)) return;
    pendingBySession.set(sessionID, { skill: skillName, injected: false, reminded: false });
  }

  const controller = new AbortController();
  void (async () => {
    for await (const event of client.event.subscribe({ signal: controller.signal })) {
      const record = (event ?? {}) as {
        type?: string;
        properties?: Record<string, unknown>;
      };
      const type = record.type;
      const properties = record.properties ?? {};
      if (type === "session.created") {
        const info = properties.info as { id?: string } | undefined;
        if (info?.id) activeSessionId = info.id;
        continue;
      }
      if (type === "session.deleted") {
        const info = properties.info as { id?: string } | undefined;
        if (info?.id) pendingBySession.delete(info.id);
        continue;
      }
      if (type !== "message.part.updated") continue;

      const part = properties.part as Record<string, unknown> | undefined;
      if (!part || part.type !== "tool") continue;
      const state = part.state as Record<string, unknown> | undefined;
      if (state?.status !== "completed") continue;
      const sessionID = sessionIdFrom(properties, part) || activeSessionId;
      if (!sessionID) continue;
      const toolName = typeof part.tool === "string" ? part.tool : "";
      if (toolName !== "skill") continue;
      handleSkill(sessionID, extractSkillName(state.input));
    }
  })();

  await client.tool.hook("execute.before", async (event: any) => {
      const sessionID = typeof event.sessionID === "string" ? event.sessionID : activeSessionId;
      if (!sessionID) return;
      const pending = pendingBySession.get(sessionID);
      if (!pending || pending.reminded) return;
      const toolName = typeof event.tool === "string" ? event.tool : "";
      if (NON_ACTION_TOOLS.has(toolName)) return;
      await remind(sessionID, pending);
  });

  await client.session.hook("context", async (event: any) => {
      const sessionID = event.sessionID || activeSessionId;
      if (!sessionID || !Array.isArray(event.system)) return;
      const pending = pendingBySession.get(sessionID);
      if (!pending || pending.injected) return;
      pending.injected = true;
      event.system.push({ type: "text", text:
        `[Memory activation reminder]\nYou loaded task-specific/action skill "${pending.skill}" but have not applied memory-activation yet. Before acting, load/apply memory-activation, or explicitly state why it is skipped for this task.`
      });
  });

  return () => controller.abort();
  },
});

export default MemoryActivationReminderPlugin;
