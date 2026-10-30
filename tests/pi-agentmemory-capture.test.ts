import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { afterEach, test } from "node:test";
import agentmemoryCapture from "../pi/extensions/agentmemory-capture/index.ts";
import { piHarness } from "./pi-harness.ts";

// The extension derives the project from the git toplevel, falling back to the
// cwd basename, so the assertion follows the same rule instead of hardcoding a
// checkout directory name.
const PROJECT = (() => {
  try {
    return basename(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
  } catch {
    return basename(process.cwd());
  }
})();

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(respond?: (path: string, body: any) => unknown) {
  const harness = piHarness(respond);
  agentmemoryCapture(harness.pi as any);
  cleanup = harness.restore;
  return harness;
}

function observations(harness: ReturnType<typeof setup>) {
  return harness.requests.filter((request) => request.path === "/agentmemory/observe").map((request) => request.body);
}

async function start(harness: ReturnType<typeof setup>, session = "session-1") {
  const ctx = harness.ctx(session);
  await harness.emit("session_start", { type: "session_start", reason: "new" }, ctx);
  return ctx;
}

function toolResult(toolName: string, result: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName,
    result: { content: [{ type: "text", text: "output" }], ...result },
    isError: false,
    durationMs: 12,
    ...extra,
  };
}

test("registers the session once and records the resolved config", async () => {
  const harness = setup((path) => (path === "/agentmemory/session/start" ? { context: "# memory context" } : {}));
  const ctx = harness.ctx("session-1");

  await harness.emit("session_start", { type: "session_start", reason: "new" }, ctx);

  assert.partialDeepStrictEqual(harness.requests[0], {
    path: "/agentmemory/session/start",
    body: {
      sessionId: "session-1",
      title: "test session",
      parentID: null,
      version: 3,
      project: PROJECT,
      cwd: process.cwd(),
    },
  });

  const config = observations(harness).find((entry) => entry.hookType === "config_loaded");
  assert.partialDeepStrictEqual(config, {
    sessionId: "session-1",
    project: PROJECT,
    data: {
      theme: "dark",
      model: "anthropic/claude-sonnet",
      autoupdate: null,
      agents: [],
      mcp_servers: ["agentmemory", "context7"],
      providers: ["anthropic", "openai"],
      permission: null,
    },
  });
});

test("records prompts with attached images as a part summary", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit(
    "input",
    { type: "input", text: "hello", images: [{ type: "image", data: "bytes", mimeType: "image/png" }], source: "interactive" },
    ctx,
  );

  const prompt = observations(harness).find((entry) => entry.hookType === "prompt_submit");
  assert.partialDeepStrictEqual(prompt.data, {
    agent: null,
    model: { providerID: "anthropic", modelID: "claude-sonnet" },
    variant: "high",
    prompt: "hello",
    files: [],
    parts_summary: ["text", "file"],
  });
  assert.ok(!JSON.stringify(observations(harness)).includes("bytes"));
});

test("records a successful tool with its stashed input and duration", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit(
    "tool_call",
    { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
    ctx,
  );
  await harness.emit("tool_execution_end", toolResult("bash"), ctx);

  const [entry] = observations(harness).filter((item) => item.hookType === "post_tool_use");
  assert.partialDeepStrictEqual(entry.data, {
    tool_name: "bash",
    call_id: "call-1",
    tool_input: JSON.stringify({ command: "ls" }),
    tool_output: "output",
    duration_ms: 12,
    title: null,
    attachments: [],
  });
});

test("prefers structured content and records failures separately", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit(
    "tool_execution_end",
    toolResult("mcp__context7__query-docs", { structuredContent: { answer: 42 } }, { isError: true }),
    ctx,
  );

  const failure = observations(harness).find((entry) => entry.hookType === "post_tool_failure");
  assert.partialDeepStrictEqual(failure.data, { tool_name: "mcp__context7__query-docs", tool_output: '{"answer":42}' });
  assert.ok(!Object.hasOwn(failure.data, "title"));
});

test("counts a tool call once even when execution ends twice", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit("tool_execution_end", toolResult("bash"), ctx);
  await harness.emit("tool_execution_end", toolResult("bash"), ctx);

  assert.strictEqual(observations(harness).filter((entry) => entry.hookType === "post_tool_use").length, 1);
});

test("drops empty agentmemory search results but keeps non-empty ones", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit(
    "tool_execution_end",
    toolResult("mcp__agentmemory__memory_recall", { structuredContent: { results: [] }, details: { mcpResult: { structuredContent: { results: [] } } } }),
    ctx,
  );
  await harness.emit(
    "tool_execution_end",
    toolResult(
      "mcp__agentmemory__memory_recall",
      { structuredContent: { results: [{ id: "1" }] }, details: { mcpResult: { structuredContent: { results: [{ id: "1" }] } } } },
      { toolCallId: "call-2" },
    ),
    ctx,
  );

  const entries = observations(harness).filter((entry) => entry.hookType === "post_tool_use");
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].data.call_id, "call-2");
});

test("resolves the search target from the mcp dispatcher details", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit(
    "tool_execution_end",
    toolResult(
      "mcp",
      {
        structuredContent: { results: [] },
        details: { server: "agentmemory", tool: "memory_smart_search", mcpResult: { structuredContent: { results: [] } } },
      },
    ),
    ctx,
  );
  assert.strictEqual(observations(harness).filter((entry) => entry.hookType === "post_tool_use").length, 0);
});

test("records finalized reasoning and error messages", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit(
    "message_end",
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "  " }, { type: "thinking", thinking: "consider it" }],
        model: "sol-6.1",
        provider: "openai",
        usage: { cost: { total: 0.02 }, input: 10, output: 20, cacheRead: 3, cacheWrite: 4 },
        stopReason: "error",
        errorMessage: "provider timeout",
      },
    },
    ctx,
  );

  const reasoning = observations(harness).filter((entry) => entry.hookType === "reasoning");
  assert.strictEqual(reasoning.length, 1);
  assert.deepStrictEqual(reasoning[0].data, { messageID: null, text: "consider it" });

  const assistant = observations(harness).find((entry) => entry.hookType === "assistant_message");
  assert.partialDeepStrictEqual(assistant.data, {
    modelID: "sol-6.1",
    providerID: "openai",
    cost: 0.02,
    finish: "error",
    error: "provider timeout",
    tokens: { input: 10, output: 20, reasoning: 0, cache_read: 3, cache_write: 4 },
  });
});

test("skips assistant messages without an error", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit(
    "message_end",
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "sol-6.1",
        provider: "openai",
        usage: { cost: { total: 0 }, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
      },
    },
    ctx,
  );
  assert.strictEqual(observations(harness).filter((entry) => entry.hookType === "assistant_message").length, 0);
});

test("injects instructions and context once, then enriches stashed files", async () => {
  const harness = setup((path) => {
    if (path === "/agentmemory/session/start") return { context: "# startup context" };
    if (path === "/agentmemory/enrich") return { context: "# file history" };
    return {};
  });
  const ctx = await start(harness);

  await harness.emit("tool_call", { type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: "README.md" } }, ctx);
  await harness.emit("tool_call", { type: "tool_call", toolCallId: "c2", toolName: "grep", input: { pattern: "foo" } }, ctx);

  const event = { type: "context_with_system", messages: [{ role: "system", content: "base", timestamp: 1 }] };
  const injected = await harness.emit("context_with_system", event, ctx);

  assert.strictEqual(injected.messages.length, 1);
  assert.ok(injected.messages[0].content.includes("base"));
  assert.ok(injected.messages[0].content.includes("<agentmemory-instructions>"));
  assert.ok(injected.messages[0].content.includes("# startup context"));
  assert.ok(injected.messages[0].content.includes("# file history"));
  assert.strictEqual(event.messages[0].content, "base");

  const enrich = harness.requests.filter((request) => request.path === "/agentmemory/enrich");
  assert.strictEqual(enrich.length, 1);
  assert.partialDeepStrictEqual(enrich[0].body, { sessionId: "session-1", files: ["README.md", "foo"], toolName: "enrich_inject" });

  // Second request: files were consumed and the instructions are one-shot.
  assert.strictEqual(
    await harness.emit("context_with_system", { type: "context_with_system", messages: [{ role: "system", content: "base", timestamp: 1 }] }, ctx),
    undefined,
  );
  assert.strictEqual(harness.requests.filter((request) => request.path === "/agentmemory/enrich").length, 1);
});

test("fetches context when session start returned none", async () => {
  let contextCalls = 0;
  const harness = setup((path) => {
    if (path === "/agentmemory/context") {
      contextCalls += 1;
      return { context: "# late context" };
    }
    return {};
  });
  const ctx = await start(harness);

  const injected = await harness.emit(
    "context_with_system",
    { type: "context_with_system", messages: [{ role: "system", content: "base", timestamp: 1 }] },
    ctx,
  );
  assert.ok(injected.messages[0].content.includes("# late context"));
  assert.strictEqual(contextCalls, 1);
});

test("handles array-shaped system content", async () => {
  const harness = setup((path) => (path === "/agentmemory/session/start" ? { context: "# ctx" } : {}));
  const ctx = await start(harness);

  const injected = await harness.emit(
    "context_with_system",
    { type: "context_with_system", messages: [{ role: "system", content: [{ type: "text", text: "base" }], timestamp: 1 }] },
    ctx,
  );
  const content = injected.messages[0].content;
  assert.strictEqual(content.length, 3);
  assert.deepStrictEqual(content[0], { type: "text", text: "base" });
  assert.strictEqual(typeof content[1].text, "string");
  assert.ok(content[1].text.includes("<agentmemory-instructions>"));
  assert.strictEqual(typeof content[2].text, "string");
  assert.ok(content[2].text.includes("# ctx"));
});

test("summarizes when the agent settles and after compaction, but not once ended", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
  await harness.emit("session_compact", { type: "session_compact", reason: "threshold" }, ctx);
  assert.strictEqual(harness.requests.filter((request) => request.path === "/agentmemory/summarize").length, 2);

  await harness.commands.get("session-end")!.handler("", ctx);
  await harness.emit("agent_settled", { type: "agent_settled", aborted: false }, ctx);
  assert.strictEqual(harness.requests.filter((request) => request.path === "/agentmemory/summarize").length, 2);
});

test("ends the session from the command, consolidates, and ignores later capture", async () => {
  const harness = setup();
  const ctx = await start(harness);

  await harness.commands.get("session-end")!.handler("", ctx);

  assert.deepStrictEqual(
    harness.requests.filter((request) => request.path === "/agentmemory/session/end").map((request) => request.body),
    [{ sessionId: "session-1" }],
  );
  assert.deepStrictEqual(
    harness.requests.filter((request) => request.path === "/agentmemory/crystals/auto").map((request) => request.body),
    [{ olderThanDays: 7 }],
  );
  assert.deepStrictEqual(
    harness.requests.filter((request) => request.path === "/agentmemory/consolidate-pipeline").map((request) => request.body),
    [{ tier: "all", force: true }],
  );
  assert.deepStrictEqual(harness.notifications, [{ message: "Session ended. Start a new session before continuing.", level: "info" }]);

  const before = observations(harness).length;
  await harness.emit("input", { type: "input", text: "after end", source: "interactive" }, ctx);
  await harness.emit("tool_execution_end", toolResult("bash"), ctx);
  assert.strictEqual(observations(harness).length, before);
});

test("ends once even when the command runs twice", async () => {
  const harness = setup();
  const ctx = await start(harness);
  await harness.commands.get("session-end")!.handler("", ctx);
  await harness.commands.get("session-end")!.handler("", ctx);
  assert.strictEqual(harness.requests.filter((request) => request.path === "/agentmemory/session/end").length, 1);
});

test("does not end capture on shutdown, only on the command", async () => {
  const harness = setup();
  const ctx = await start(harness);
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

  assert.strictEqual(harness.requests.filter((request) => request.path === "/agentmemory/session/end").length, 0);
  // Session-scoped state is gone, so a stray bus event cannot resurrect it.
  harness.emitBus("permissions:ui_prompt", { requestId: "req-1", surface: "bash", value: "ls" });
  assert.strictEqual(observations(harness).filter((entry) => entry.hookType === "notification").length, 0);
});

test("correlates a permission prompt with its decision", async () => {
  const harness = setup();
  const ctx = await start(harness);

  harness.emitBus("permissions:ready", { sessionId: "session-1" });
  harness.emitBus("permissions:ui_prompt", { requestId: "req-1", surface: "bash", value: "git status" });
  harness.emitBus("permissions:decision", {
    requestId: "req-1",
    result: "once",
    resolution: "user",
    origin: "dialog",
    matchedPattern: "git *",
  });
  await harness.drain();

  const prompt = observations(harness).find((entry) => entry.hookType === "notification");
  assert.deepStrictEqual(prompt.data, {
    notification_type: "permission_prompt",
    permission: "bash",
    pattern: "git status",
    patterns: ["git status"],
    tool_call_id: null,
    title: "bash: git status",
  });

  const reply = observations(harness).find((entry) => entry.hookType === "permission_replied");
  assert.deepStrictEqual(reply.data, {
    permission_id: "req-1",
    response: "once",
    permission: "bash",
    pattern: "git status",
    patterns: ["git status"],
    tool_call_id: null,
    title: "bash: git status",
    resolution: "user",
    origin: "dialog",
    matched_pattern: "git *",
  });
});

test("skips unattributed decisions unless the resolution is an anomaly", async () => {
  const harness = setup();
  await start(harness);

  harness.emitBus("permissions:decision", { requestId: "req-a", resolution: "user", result: "once" });
  await harness.drain();
  assert.strictEqual(observations(harness).filter((entry) => entry.hookType === "permission_replied").length, 0);

  harness.emitBus("permissions:decision", { requestId: "req-b", resolution: "gate_error", result: "deny" });
  await harness.drain();
  const reply = observations(harness).find((entry) => entry.hookType === "permission_replied");
  assert.partialDeepStrictEqual(reply.data, { permission_id: "req-b", resolution: "gate_error", title: "unknown" });
});

test("ignores a child session announcement the extension did not capture", async () => {
  const harness = setup();
  await start(harness, "parent");

  harness.emitBus("permissions:ready", { sessionId: "child" });
  harness.emitBus("permissions:ui_prompt", { requestId: "req-1", surface: "bash", value: "ls" });
  await harness.drain();

  const prompt = observations(harness).find((entry) => entry.hookType === "notification");
  assert.strictEqual(prompt.sessionId, "parent");
});

test("targets the agentmemory API prefix and tolerates a dead server", async () => {
  const harness = setup();
  const ctx = await start(harness);

  const first = harness.requests[0];
  assert.strictEqual(first.path, "/agentmemory/session/start");
  assert.ok(first.url.startsWith(process.env.AGENTMEMORY_URL || "http://localhost:3111"));

  // A rejected or unreachable endpoint must not break the hook pipeline.
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  await harness.emit("input", { type: "input", text: "still works", source: "interactive" }, ctx);
  await harness.emit(
    "context_with_system",
    { type: "context_with_system", messages: [{ role: "system", content: "base", timestamp: 1 }] },
    ctx,
  );
});
