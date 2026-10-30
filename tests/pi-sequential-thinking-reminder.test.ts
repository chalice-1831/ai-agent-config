import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import sequentialThinkingReminder from "../pi/extensions/sequential-thinking-reminder/index.ts";
import { piHarness } from "./pi-harness.ts";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const harness = piHarness();
  sequentialThinkingReminder(harness.pi as any);
  cleanup = harness.restore;
  return harness;
}

function assistantMessage(thoughts: string[], role: "assistant" | "user" = "assistant") {
  return {
    type: "message_end",
    message: {
      role,
      content: thoughts.map((thinking) => ({ type: "thinking", thinking })),
    },
  };
}

async function think(harness: ReturnType<typeof setup>, session: string, thoughts: string[]) {
  await harness.emit("message_end", assistantMessage(thoughts), harness.ctx(session));
}

function toolResult(toolName: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { type: "tool_result", toolCallId: "call-1", toolName, input, content: [], isError: false, ...extra };
}

test("announces itself once and reminds after two finalized thoughts", async () => {
  const harness = setup();
  const ctx = harness.ctx("session-1");

  const first = await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx);
  assert.strictEqual(first, undefined);
  assert.deepStrictEqual(harness.notifications, [
    { message: "Monitoring reasoning thoughts and sequential-thinking usage.", level: "info" },
  ]);
  assert.deepStrictEqual(harness.entries, [
    { customType: "sequential-thinking-reminder", data: { trigger: "active", message: "Monitoring reasoning thoughts and sequential-thinking usage." } },
  ]);

  await think(harness, "session-1", ["one"]);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);

  await think(harness, "session-1", ["two"]);
  const event = { type: "context_with_system", messages: [{ role: "system", content: "base", timestamp: 1 }] };
  const injected = await harness.emit("context_with_system", event, ctx);

  assert.strictEqual(injected.messages.length, 2);
  assert.strictEqual(injected.messages[1].role, "system");
  assert.ok(injected.messages[1].content.includes("completed 2 reasoning thoughts"));
  assert.strictEqual(event.messages.length, 1);
  assert.deepStrictEqual(harness.entries.at(-1), {
    customType: "sequential-thinking-reminder",
    data: {
      trigger: "reminder",
      message: "The agent has completed 2 reasoning thoughts without using the sequential-thinking tool. Use sequential-thinking before continuing.",
      thoughtCount: 2,
      reminderLevel: 1,
    },
  });

  // The active notice is one-shot per session.
  await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx);
  assert.strictEqual(harness.notifications.filter((entry) => entry.level === "info").length, 1);
});

test("counts only nonempty thoughts of assistant messages", async () => {
  const harness = setup();
  const ctx = harness.ctx("session-2");

  await think(harness, "session-2", ["", "   "]);
  await harness.emit("message_end", assistantMessage(["user thought"], "user"), ctx);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);

  await think(harness, "session-2", ["real", "real"]);
  assert.strictEqual(
    (await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx)).messages.length,
    1,
  );
});

test("counts a thinking part once even when a message carries several", async () => {
  const harness = setup();
  const ctx = harness.ctx("session-3");

  await think(harness, "session-3", ["packed"]);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
  await think(harness, "session-3", ["packed"]);
  assert.strictEqual(
    (await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx)).messages.length,
    1,
  );
});

test("keeps counters per session", async () => {
  const harness = setup();
  await think(harness, "session-a", ["a1", "a2"]);

  // A different session has its own counter and must not inherit the reminder.
  assert.strictEqual(
    await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, harness.ctx("session-b")),
    undefined,
  );
  assert.strictEqual(
    (await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, harness.ctx("session-a"))).messages.length,
    1,
  );
});

test("resets after a successful sequential-thinking call", async () => {
  const harness = setup();
  const ctx = harness.ctx("session-4");
  await think(harness, "session-4", ["a", "b"]);

  await harness.emit("tool_result", toolResult("sequentialthinking", { thought: "x" }), ctx);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
  assert.ok(
    harness.entries.some(
      (entry) => entry.customType === "sequential-thinking-reminder" && entry.data?.trigger === "successful_tool",
    ),
  );

  await think(harness, "session-4", ["c"]);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);
});

test("resets only for a real call through the mcp dispatcher", async () => {
  const harness = setup();
  const ctx = harness.ctx("session-5");
  await think(harness, "session-5", ["a", "b"]);

  // A management action on the same server is not a thinking call.
  await harness.emit("tool_result", toolResult("mcp", { action: "list", server: "sequential-thinking" }), ctx);
  assert.strictEqual(
    (await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx)).messages.length,
    1,
  );

  await harness.emit("tool_result", toolResult("mcp", { tool: "sequentialthinking", server: "sequential-thinking" }), ctx);
  assert.strictEqual(
    await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, harness.ctx("session-5")),
    undefined,
  );
});

test("does not reset on failure, adapter error, or another tool", async () => {
  const harness = setup();
  const ctx = harness.ctx("session-6");
  await think(harness, "session-6", ["a", "b"]);

  await harness.emit("tool_result", toolResult("bash", { command: "ls" }), ctx);
  await harness.emit("tool_result", toolResult("sequentialthinking", {}, { isError: true }), ctx);
  await harness.emit("tool_result", toolResult("sequentialthinking", {}, { details: { error: "adapter down" } }), ctx);
  await harness.emit(
    "tool_result",
    toolResult("sequentialthinking", {}, { details: { mcpResult: { isError: true } } }),
    ctx,
  );

  assert.strictEqual(
    (await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx)).messages.length,
    1,
  );
});

test("escalates at every further pair of thoughts", async () => {
  const harness = setup();
  const ctx = harness.ctx("session-7");
  await think(harness, "session-7", ["a", "b"]);
  await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx);
  await think(harness, "session-7", ["c", "d"]);
  await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx);
  assert.strictEqual(await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx), undefined);

  const reminders = harness.entries.filter((entry) => entry.data?.trigger === "reminder");
  assert.deepStrictEqual(reminders.map((entry) => entry.data.reminderLevel), [1, 2]);
  assert.strictEqual(reminders[1].data.thoughtCount, 4);
  assert.strictEqual(harness.notifications.filter((entry) => entry.level === "warning").length, 2);
});

test("skips the UI notification without a UI but still injects and records", async () => {
  const harness = setup();
  const ctx = harness.ctx("session-8", { hasUI: false });
  await think(harness, "session-8", ["a", "b"]);

  const injected = await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, ctx);
  assert.strictEqual(injected.messages.length, 1);
  assert.deepStrictEqual(harness.notifications, []);
  assert.strictEqual(harness.entries.filter((entry) => entry.data?.trigger === "reminder").length, 1);
});

test("clears session state on shutdown", async () => {
  const harness = setup();
  await think(harness, "session-9", ["a"]);
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx("session-9"));

  // A fresh start for the same id begins from zero, so the two old thoughts are gone.
  await harness.emit("session_start", { type: "session_start", reason: "new" }, harness.ctx("session-9"));
  await think(harness, "session-9", ["b"]);
  assert.strictEqual(
    await harness.emit("context_with_system", { type: "context_with_system", messages: [] }, harness.ctx("session-9")),
    undefined,
  );
});
