import type { Plugin } from "@opencode-ai/plugin";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REMINDER_INTERVAL = 10;
const GLOBAL_AGENTS_PATH = join(homedir(), ".config", "opencode", "AGENTS.md");
const REMINDER =
  "继续前，请检查当前行动是否符合全局 AGENTS.md 的约束；按当前任务范围判断是否需要补充局部 AGENTS.md。";

type SessionState = {
  callsSinceReminder: number;
  compactionInProgress: boolean;
  remindAfterCompaction: boolean;
  missingRuleLogged: boolean;
};

function sessionIdFrom(input: { sessionID?: unknown }, activeSessionID: string): string {
  return typeof input.sessionID === "string" && input.sessionID ? input.sessionID : activeSessionID;
}

export const AgentsMDReminderPlugin: Plugin = async ({ client }) => {
  const sessions = new Map<string, SessionState>();
  let activeSessionID = "";
  const hasGlobalAgents = existsSync(GLOBAL_AGENTS_PATH);

  async function log(sessionID: string, trigger: string, callsSinceReminder: number, skipped = false): Promise<void> {
    try {
      await client.app.log({
        body: {
          service: "agents-md-reminder",
          level: skipped ? "info" : "debug",
          message: skipped ? "Skipped reminder: global AGENTS.md was not found" : "Injected AGENTS.md reminder",
          sessionID,
          trigger,
          callsSinceReminder,
        },
      });
    } catch {}
  }

  return {
    event: async ({ event }) => {
      const properties = (event as { properties?: Record<string, unknown> }).properties ?? {};
      if (event.type === "session.created") {
        const info = properties.info as Record<string, unknown> | undefined;
        const sessionID = typeof info?.id === "string" ? info.id : "";
        if (sessionID) {
          activeSessionID = sessionID;
          sessions.set(sessionID, { callsSinceReminder: 0, compactionInProgress: false, remindAfterCompaction: false, missingRuleLogged: false });
        }
        return;
      }

      if (event.type === "session.compacted") {
        const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : activeSessionID;
        if (!sessionID) return;
        const state = sessions.get(sessionID) ?? { callsSinceReminder: 0, compactionInProgress: false, remindAfterCompaction: false, missingRuleLogged: false };
        state.compactionInProgress = false;
        state.remindAfterCompaction = true;
        sessions.set(sessionID, state);
        return;
      }

      if (event.type === "session.deleted") {
        const info = properties.info as Record<string, unknown> | undefined;
        const sessionID = typeof info?.id === "string" ? info.id : properties.sessionID;
        if (typeof sessionID === "string") sessions.delete(sessionID);
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!Array.isArray(output.system)) return;
      const sessionID = sessionIdFrom(input, activeSessionID);
      if (!sessionID) return;

      const state = sessions.get(sessionID) ?? { callsSinceReminder: 0, compactionInProgress: false, remindAfterCompaction: false, missingRuleLogged: false };
      if (state.compactionInProgress) {
        state.compactionInProgress = false;
        sessions.set(sessionID, state);
        return;
      }
      const afterCompaction = state.remindAfterCompaction;
      state.remindAfterCompaction = false;

      if (!hasGlobalAgents) {
        if (!state.missingRuleLogged) {
          state.missingRuleLogged = true;
          await log(sessionID, "global_rule_missing", state.callsSinceReminder, true);
        }
        sessions.set(sessionID, state);
        return;
      }

      state.callsSinceReminder += 1;
      const periodic = state.callsSinceReminder >= REMINDER_INTERVAL;

      if (!afterCompaction && !periodic) {
        sessions.set(sessionID, state);
        return;
      }

      output.system.push(`[AGENTS.md reminder]\n${REMINDER}`);
      const trigger = afterCompaction ? "after_compaction" : "periodic";
      state.callsSinceReminder = 0;
      sessions.set(sessionID, state);
      await log(sessionID, trigger, 0);
    },

    "experimental.session.compacting": async (input) => {
      const sessionID = sessionIdFrom(input, activeSessionID);
      if (!sessionID) return;
      const state = sessions.get(sessionID) ?? { callsSinceReminder: 0, compactionInProgress: false, remindAfterCompaction: false, missingRuleLogged: false };
      state.compactionInProgress = true;
      sessions.set(sessionID, state);
    },
  };
};

export default AgentsMDReminderPlugin;
