import { Plugin } from "@opencode/plugin";
import { MemoryActivationReminderRpc } from "./rpc";

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
  for (const key of ["id", "name", "skill", "skillName"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export const MemoryActivationReminderPlugin = Plugin.define({
  id: "memory-activation-reminder",
  async setup(ctx) {
  const client = ctx;
  const pendingBySession = new Map<string, PendingActivation>();
  const reminders = await ctx.rpc.register(MemoryActivationReminderRpc, {});

  async function remind(sessionID: string, pending: PendingActivation): Promise<void> {
    if (pending.reminded) return;
    pending.reminded = true;
    const message = `Loaded task skill "${pending.skill}" without applying ${ACTIVATION_SKILL}. Load/apply ${ACTIVATION_SKILL} before acting, or state why it is skipped.`;
    console.warn(`[memory-activation-reminder] ${sessionID}: ${message}`);
    try {
      await reminders.events.emit("reminder", { sessionID, message });
    } catch (error) {
      pending.reminded = false;
      console.error(`[memory-activation-reminder] Failed to emit reminder for ${sessionID}`, error);
    }
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
        data?: Record<string, unknown>;
      };
      const type = record.type;
      const data = record.data ?? {};
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : "";
      if (!sessionID) continue;
      if (type === "session.deleted") {
        pendingBySession.delete(sessionID);
        continue;
      }
      if (type === "session.skill.activated") {
        handleSkill(sessionID, extractSkillName(data));
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) {
      console.error("[memory-activation-reminder] Event subscription failed", error);
    }
  });

  await client.tool.hook("execute.after", (event: any) => {
      if (event.tool === "skill" && event.status === "completed") {
        handleSkill(event.sessionID, extractSkillName(event.input));
      }
  });

  await client.tool.hook("execute.before", async (event: any) => {
      const sessionID = event.sessionID;
      if (!sessionID) return;
      const pending = pendingBySession.get(sessionID);
      if (!pending || pending.reminded) return;
      const toolName = typeof event.tool === "string" ? event.tool : "";
      if (NON_ACTION_TOOLS.has(toolName)) return;
      await remind(sessionID, pending);
  });

  await client.session.hook("context", async (event: any) => {
      const sessionID = event.sessionID;
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
