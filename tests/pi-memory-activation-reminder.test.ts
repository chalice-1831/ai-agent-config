import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import memoryActivationReminder from "../pi/extensions/memory-activation-reminder/index.ts";
import { piHarness } from "./pi-harness.ts";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(skillPaths: Record<string, string> = {}) {
  const harness = piHarness();
  for (const [name, path] of Object.entries(skillPaths)) {
    harness.skills.push({ name, path });
  }
  memoryActivationReminder(harness.pi as any);
  cleanup = harness.restore;
  return harness;
}

const SKILL_PATH = "skills/minimal-correct-change/SKILL.md";
const ACTIVATION_PATH = "skills/memory-activation/SKILL.md";

function readResult(text: string) {
  return {
    type: "tool_result",
    toolCallId: "call-read",
    toolName: "read",
    input: { path: SKILL_PATH },
    content: [{ type: "text", text }],
    isError: false,
  };
}

function skillInvocationMessage(name: string, path: string) {
  return {
    type: "message_start",
    message: {
      role: "user",
      content: `<skill name="${name}" location="${path}">\n# ${name}\nbody\n</skill>`,
    },
  };
}

test("injects one system reminder after a task skill is read", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  const ctx = harness.ctx("session-1");

  await harness.emit("tool_result", readResult("# skill"), ctx);
  const event = { type: "context_with_system", messages: [{ role: "system", content: "base", timestamp: 1 }] };
  const injected = await harness.emit("context_with_system", event, ctx);

  assert.strictEqual(injected.messages.length, 2);
  assert.ok(injected.messages[1].content.includes('"minimal-correct-change"'));
  assert.ok(injected.messages[1].content.includes("Memory activation reminder"));
  assert.strictEqual(event.messages.length, 1);

  // Injection is one-shot: the same pending skill is not injected twice.
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
});

test("ignores reads of files that are not discovered skills", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  const ctx = harness.ctx("session-2");

  await harness.emit(
    "tool_result",
    { ...readResult("# skill"), input: { path: "docs/SKILL.md" } },
    ctx,
  );
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
});

test("ignores failed reads", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  const ctx = harness.ctx("session-3");

  await harness.emit("tool_result", { ...readResult("denied"), isError: true }, ctx);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
});

test("does not create pending state for memory/reference skills", async () => {
  const harness = setup({
    recall: "skills/recall/SKILL.md",
    "agentmemory-mcp-tools": "skills/agentmemory-mcp-tools/SKILL.md",
  });
  const ctx = harness.ctx("session-4");

  await harness.emit("tool_result", { ...readResult("# recall"), input: { path: "skills/recall/SKILL.md" } }, ctx);
  await harness.emit(
    "tool_result",
    { ...readResult("# tools"), input: { path: "skills/agentmemory-mcp-tools/SKILL.md" } },
    ctx,
  );
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
});

test("clears pending state when memory-activation itself is read", async () => {
  const harness = setup({
    "minimal-correct-change": SKILL_PATH,
    "memory-activation": ACTIVATION_PATH,
  });
  const ctx = harness.ctx("session-5");

  await harness.emit("tool_result", readResult("# task skill"), ctx);
  await harness.emit("tool_result", { ...readResult("# activation"), input: { path: ACTIVATION_PATH } }, ctx);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
});

test("warns once on the next action tool and skips reads of skills", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  const ctx = harness.ctx("session-6");

  await harness.emit("tool_result", readResult("# skill"), ctx);
  // Reading another skill file is not an action; it must neither warn nor clear.
  await harness.emit("tool_result", { ...readResult("# other"), input: { path: SKILL_PATH } }, ctx);
  assert.deepStrictEqual(harness.notifications, []);

  await harness.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "call-bash", toolName: "bash", input: { command: "ls" } },
    ctx,
  );
  assert.strictEqual(harness.notifications.length, 1);
  assert.deepStrictEqual(harness.notifications[0], {
    message:
      'Loaded task skill "minimal-correct-change" without applying memory-activation. Load/apply memory-activation before acting, or state why it is skipped.',
    level: "warning",
  });
  assert.deepStrictEqual(harness.entries.at(-1), {
    customType: "memory-activation-reminder",
    data: { skill: "minimal-correct-change", message: harness.notifications[0].message },
  });

  // Only one warning per pending skill load.
  await harness.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "call-bash-2", toolName: "bash", input: { command: "ls" } },
    ctx,
  );
  assert.strictEqual(harness.notifications.length, 1);
});

test("exempts recall tools, including the mcp dispatcher and codemode", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  const ctx = harness.ctx("session-7");

  await harness.emit("tool_result", readResult("# skill"), ctx);
  const calls = [
    { toolCallId: "1", toolName: "memory_lesson_recall", input: {} },
    { toolCallId: "2", toolName: "mcp__agentmemory__memory_smart_search", input: {} },
    { toolCallId: "3", toolName: "mcp__agentmemory", input: { tool: "memory_recall" } },
    { toolCallId: "4", toolName: "mcp", input: { tool: "memory_recall", server: "agentmemory" } },
    { toolCallId: "5", toolName: "codemode", input: {} },
  ];
  for (const call of calls) {
    await harness.emit("tool_call", { type: "tool_call", ...call }, ctx);
  }
  assert.deepStrictEqual(harness.notifications, []);

  // A management action on the dispatcher is not a recall and must warn.
  await harness.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "6", toolName: "mcp", input: { action: "install", server: "agentmemory" } },
    ctx,
  );
  assert.strictEqual(harness.notifications.length, 1);
});

test("tracks pending state per session", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  await harness.emit("tool_result", readResult("# skill"), harness.ctx("session-a"));

  const injectedB = await harness.emit(
    "context_with_system",
    { type: "context_with_system", messages: [] },
    harness.ctx("session-b"),
  );
  assert.strictEqual(injectedB, undefined);

  await harness.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "call", toolName: "bash", input: { command: "ls" } },
    harness.ctx("session-b"),
  );
  assert.deepStrictEqual(harness.notifications, []);
});

test("detects /skill:name expansion from a steering message", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  const ctx = harness.ctx("session-8");

  await harness.emit("message_start", skillInvocationMessage("minimal-correct-change", SKILL_PATH), ctx);
  const injected = await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx);
  assert.strictEqual(injected.messages.length, 1);
});

test("ignores a skill block whose location is not the discovered skill", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  const ctx = harness.ctx("session-9");

  await harness.emit("message_start", skillInvocationMessage("minimal-correct-change", "skills/spoof/SKILL.md"), ctx);
  await harness.emit("message_start", skillInvocationMessage("unknown-skill", SKILL_PATH), ctx);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
});

test("a later task skill replaces the pending one and re-arms the reminder", async () => {
  const harness = setup({
    "minimal-correct-change": SKILL_PATH,
    "audience-boundary": "skills/audience-boundary/SKILL.md",
  });
  const ctx = harness.ctx("session-10");

  await harness.emit("tool_result", readResult("# first"), ctx);
  await harness.emit(
    "tool_result",
    { ...readResult("# second"), input: { path: "skills/audience-boundary/SKILL.md" } },
    ctx,
  );
  const injected = await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx);
  assert.ok(injected.messages.at(-1).content.includes('"audience-boundary"'));

  await harness.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "call", toolName: "edit", input: { path: "README.md" } },
    ctx,
  );
  assert.strictEqual(harness.notifications.length, 1);
  assert.ok(harness.notifications[0].message.includes('"audience-boundary"'));
});

test("skips the toast without a UI but keeps the log entry", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  const ctx = harness.ctx("session-11", { hasUI: false });

  await harness.emit("tool_result", readResult("# skill"), ctx);
  await harness.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "call", toolName: "bash", input: { command: "ls" } },
    ctx,
  );
  assert.deepStrictEqual(harness.notifications, []);
  assert.strictEqual(harness.entries.at(-1)?.customType, "memory-activation-reminder");
});

test("clears pending state on session shutdown", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  await harness.emit("tool_result", readResult("# skill"), harness.ctx("session-12"));
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx("session-12"));

  assert.strictEqual(
    await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, harness.ctx("session-12")),
    undefined,
  );
});

test("clears pending state when a session starts again under the same id", async () => {
  const harness = setup({ "minimal-correct-change": SKILL_PATH });
  await harness.emit("tool_result", readResult("# skill"), harness.ctx("session-13"));

  // Pi re-emits session_start for reload/resume without reloading the extension,
  // so a stale pending skill must not leak into the restarted session.
  await harness.emit("session_start", { type: "session_start", reason: "resume" }, harness.ctx("session-13"));
  assert.strictEqual(
    await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, harness.ctx("session-13")),
    undefined,
  );
});
