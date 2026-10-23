import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const ACTIVATION_SKILL = "memory-activation";
const SKIP_SKILLS = new Set([
  ACTIVATION_SKILL, "agentmemory-mcp-tools", "forget", "lesson", "memory-discipline",
  "recall", "recap", "remember", "session-history",
]);
const RECALL_TOOLS = new Set(["memory_lesson_recall", "memory_recall", "memory_smart_search"]);

type PendingActivation = { skill: string; injected: boolean; reminded: boolean };

function canonicalPath(path: string, cwd: string): string {
  const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
  try { return realpathSync(expanded); } catch { return expanded; }
}

function isRecall(tool: string, server?: unknown): boolean {
  if (RECALL_TOOLS.has(tool)) return server === undefined || server === "agentmemory";
  return (server === undefined || server === "agentmemory") &&
    [...RECALL_TOOLS].some((name) => tool === `agentmemory_${name}` || tool === `mcp__agentmemory__${name}`);
}

function isRecallCall(tool: string, input: Record<string, unknown>): boolean {
  if (tool === "mcp") {
    // The adapter dispatches actions before tool calls; do not exempt an install/auth action.
    return !input.action && typeof input.tool === "string" && isRecall(input.tool, input.server);
  }
  if (tool === "mcp__agentmemory") {
    return typeof input.tool === "string" && isRecall(input.tool, "agentmemory");
  }
  return isRecall(tool);
}

export default function memoryActivationReminder(pi: ExtensionAPI) {
  let pending: PendingActivation | undefined;

  pi.on("session_start", () => { pending = undefined; });

  function handleSkill(skill: string) {
    if (skill === ACTIVATION_SKILL) {
      pending = undefined;
    } else if (skill && !SKIP_SKILLS.has(skill)) {
      pending = { skill, injected: false, reminded: false };
    }
  }

  function skillForRead(input: Record<string, unknown>, cwd: string): string | undefined {
    if (typeof input.path !== "string") return;
    const path = canonicalPath(input.path, cwd);
    const command = pi.getCommands().find((command) =>
      command.source === "skill" && canonicalPath(command.sourceInfo.path, cwd) === path);
    return command?.name.replace(/^skill:/, "");
  }

  // Pi loads skills via read, not OpenCode's dedicated skill tool. Only successful
  // reads of a discovered skill count; arbitrary files named SKILL.md do not.
  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    if (isRecallCall(event.toolName, event.input)) {
      pending = undefined;
      return;
    }
    if (event.toolName !== "read") return;
    const skill = skillForRead(event.input, ctx.cwd);
    if (skill) handleSkill(skill);
  });

  // /skill:name expands before message delivery; message_start also sees queued
  // steering skills, which do not produce another before_agent_start event.
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n[\s\S]+)?$/);
    if (match && skillForRead({ path: match[2] }, ctx.cwd) === match[1]) handleSkill(match[1]);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!pending || pending.reminded) return;
    if (event.toolName === "read" && skillForRead(event.input, ctx.cwd)) return;
    if (isRecallCall(event.toolName, event.input)) return;
    // Pi codemode invokes nested tools through the same hooks. Judge the actual
    // calls instead of warning on the dispatcher before a nested recall can run.
    if (event.toolName === "codemode") return;
    pending.reminded = true;
    const message = `Loaded task skill "${pending.skill}" without memory recall. Run same-scope memory_lesson_recall before acting, or state why recall is skipped under AGENTS.md.`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    pi.appendEntry("memory-activation-reminder", { skill: pending.skill, message });
  });

  pi.on("context_with_system", (event) => {
    if (!pending || pending.injected) return;
    pending.injected = true;
    return {
      messages: [...event.messages, {
        role: "system" as const,
        content: `[Memory activation reminder]\nYou loaded task-specific/action skill "${pending.skill}" but have not recalled relevant memory yet. Before acting, run same-scope memory_lesson_recall as required by AGENTS.md, or explicitly state why recall is skipped for this task.`,
        timestamp: Date.now(),
      }],
    };
  });
}
