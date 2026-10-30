import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  // One pending activation per session, like the OpenCode plugin: a skill loaded
  // in one session must not warn inside another.
  const pendingBySession = new Map<string, PendingActivation>();

  function pendingFor(ctx: ExtensionContext): PendingActivation | undefined {
    return pendingBySession.get(ctx.sessionManager.getSessionId());
  }

  pi.on("session_start", (_event, ctx) => { pendingBySession.delete(ctx.sessionManager.getSessionId()); });
  pi.on("session_shutdown", (_event, ctx) => { pendingBySession.delete(ctx.sessionManager.getSessionId()); });

  function handleSkill(ctx: ExtensionContext, skill: string) {
    const sid = ctx.sessionManager.getSessionId();
    if (skill === ACTIVATION_SKILL) {
      pendingBySession.delete(sid);
    } else if (skill && !SKIP_SKILLS.has(skill)) {
      pendingBySession.set(sid, { skill, injected: false, reminded: false });
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
    if (event.toolName !== "read") return;
    const skill = skillForRead(event.input, ctx.cwd);
    if (skill) handleSkill(ctx, skill);
  });

  // /skill:name expands before message delivery; message_start also sees queued
  // steering skills, which do not produce another before_agent_start event.
  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") return;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n[\s\S]*?\n<\/skill>(?:\n\n[\s\S]+)?$/);
    if (match && skillForRead({ path: match[2] }, ctx.cwd) === match[1]) handleSkill(ctx, match[1]);
  });

  pi.on("tool_call", (event, ctx) => {
    const pending = pendingFor(ctx);
    if (!pending || pending.reminded) return;
    if (event.toolName === "read" && skillForRead(event.input, ctx.cwd)) return;
    if (isRecallCall(event.toolName, event.input)) return;
    // Pi codemode invokes nested tools through the same hooks. Judge the actual
    // calls instead of warning on the dispatcher before a nested recall can run.
    if (event.toolName === "codemode") return;
    pending.reminded = true;
    const message = `Loaded task skill "${pending.skill}" without applying ${ACTIVATION_SKILL}. Load/apply ${ACTIVATION_SKILL} before acting, or state why it is skipped.`;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    pi.appendEntry("memory-activation-reminder", { skill: pending.skill, message });
  });

  pi.on("context_with_system", (event, ctx) => {
    const pending = pendingFor(ctx);
    if (!pending || pending.injected) return;
    pending.injected = true;
    return {
      messages: [...event.messages, {
        role: "system" as const,
        content: `[Memory activation reminder]\nYou loaded task-specific/action skill "${pending.skill}" but have not applied memory-activation yet. Before acting, load/apply memory-activation, or explicitly state why it is skipped for this task.`,
        timestamp: Date.now(),
      }],
    };
  });
}
