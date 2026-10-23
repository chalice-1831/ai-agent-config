import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REMINDER_INTERVAL = 10;
const GLOBAL_AGENTS_PATH = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "AGENTS.md");
const REMINDER =
  "继续前，请检查当前行动是否符合全局 AGENTS.md 的约束；按当前任务范围判断是否需要补充局部 AGENTS.md。";

export default function agentsMDReminder(pi: ExtensionAPI) {
  let callsSinceReminder = 0;
  let remindAfterCompaction = false;
  let missingRuleLogged = false;
  const hasGlobalAgents = existsSync(GLOBAL_AGENTS_PATH);

  pi.on("session_start", () => {
    callsSinceReminder = 0;
    remindAfterCompaction = false;
    missingRuleLogged = false;
  });

  pi.on("session_compact", () => {
    remindAfterCompaction = true;
  });

  // Unlike the OpenCode compaction hook, this only runs for normal agent requests.
  pi.on("context_with_system", (event) => {
    if (!hasGlobalAgents) {
      if (!missingRuleLogged) {
        missingRuleLogged = true;
        pi.appendEntry("agents-md-reminder", { trigger: "global_rule_missing", callsSinceReminder });
      }
      return;
    }
    callsSinceReminder += 1;
    if (!remindAfterCompaction && callsSinceReminder < REMINDER_INTERVAL) return;

    const trigger = remindAfterCompaction ? "after_compaction" : "periodic";
    remindAfterCompaction = false;
    callsSinceReminder = 0;
    pi.appendEntry("agents-md-reminder", { trigger, callsSinceReminder });
    return {
      messages: [...event.messages, {
        role: "system" as const,
        content: `[AGENTS.md reminder]\n${REMINDER}`,
        timestamp: Date.now(),
      }],
    };
  });
}
