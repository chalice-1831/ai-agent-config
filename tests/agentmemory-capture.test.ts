import { afterEach, expect, test } from "bun:test";
import { AgentmemoryCapturePlugin } from "../opencode/plugins/agentmemory-capture";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("correlates permission replies with the permission prompt context", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "permission.asked", properties: {
    id: "per-1",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["git status", "git show *"],
    metadata: { token: "private" },
  } } as any });
  await plugin.event?.({ event: { type: "permission.replied", properties: {
    requestID: "per-1",
    sessionID: "session-1",
    reply: "once",
  } } as any });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  const reply = observations.find((observation) => observation.hookType === "permission_replied");
  expect(reply?.data).toEqual({
    permission_id: "per-1",
    response: "once",
    permission: "bash",
    pattern: "git status, git show *",
    patterns: ["git status", "git show *"],
    tool_call_id: null,
    title: "bash",
  });
  expect(JSON.stringify(observations)).not.toContain("private");
});

test("skips permission replies without prompt context", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "permission.replied", properties: {
    requestID: "missing",
    sessionID: "session-2",
    reply: "once",
  } } as any });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("correlates removed messages with the last message update", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "message.updated", properties: {
    sessionID: "session-3",
    info: {
      id: "msg-1",
      sessionID: "session-3",
      role: "assistant",
      parentID: "msg-parent",
      modelID: "model-1",
      providerID: "provider-1",
      mode: "build",
      finish: "stop",
    },
  } } as any });
  await plugin.event?.({ event: { type: "message.removed", properties: {
    sessionID: "session-3",
    messageID: "msg-1",
  } } as any });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  const removed = observations.find((observation) => observation.hookType === "message_removed");
  expect(removed?.data).toEqual({
    messageID: "msg-1",
    role: "assistant",
    parentID: "msg-parent",
    modelID: "model-1",
    providerID: "provider-1",
    mode: "build",
    finish: "stop",
    error: null,
  });
});

test("skips assistant messages without errors", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "message.updated", properties: {
    sessionID: "session-assistant-success",
    info: {
      id: "msg-success",
      sessionID: "session-assistant-success",
      role: "assistant",
      modelID: "model-1",
      providerID: "provider-1",
      finish: "stop",
      tokens: { input: 1, output: 2 },
    },
  } } as any });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps assistant messages with errors", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "message.updated", properties: {
    sessionID: "session-assistant-error",
    info: {
      id: "msg-error",
      sessionID: "session-assistant-error",
      role: "assistant",
      modelID: "model-1",
      providerID: "provider-1",
      error: { message: "provider timeout" },
    },
  } } as any });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  expect(observations).toHaveLength(1);
  expect(observations[0].hookType).toBe("assistant_message");
  expect(observations[0].data.error).toBe("provider timeout");
});

test("skips removed messages without message update context", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "message.removed", properties: {
    sessionID: "session-4",
    messageID: "missing",
  } } as any });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("skips empty agentmemory search tool results", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-5",
    part: {
      type: "tool",
      sessionID: "session-5",
      callID: "call-1",
      tool: "agentmemory_memory_recall",
      state: {
        status: "completed",
        input: { query: "missing" },
        output: { results: [], tokens_used: 10 },
      },
    },
  } } as any });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps non-empty agentmemory search tool results", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-6",
    part: {
      type: "tool",
      sessionID: "session-6",
      callID: "call-1",
      tool: "agentmemory_memory_recall",
      state: {
        status: "completed",
        input: { query: "permission" },
        output: { results: [{ title: "Permission hook fix" }], tokens_used: 10 },
      },
    },
  } } as any });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  expect(observations).toHaveLength(1);
  expect(observations[0].hookType).toBe("post_tool_use");
  expect(observations[0].data.tool_name).toBe("agentmemory_memory_recall");
});

test("skips session updates that only contain file names", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "session.updated", properties: {
    sessionID: "session-7",
    info: {
      id: "session-7",
      summary: {
        files: ["register_defs.go", "oper_def_uninstall_node.go", "backend/AGENTS.md"],
      },
    },
  } } as any });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps session diffs that include changed line counts", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "session.diff", properties: {
    sessionID: "session-8",
    diff: [
      { file: "backend/register_defs.go", additions: 2, deletions: 1 },
    ],
  } } as any });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  expect(observations).toHaveLength(1);
  expect(observations[0].hookType).toBe("session_diff");
  expect(observations[0].data).toMatchObject({
    files: ["backend/register_defs.go"],
    additions: 2,
    deletions: 1,
  });
});

test("skips lifecycle and telemetry-only events", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "session.status", properties: {
    sessionID: "session-9",
    status: { type: "idle" },
  } } as any });
  await plugin.event?.({ event: { type: "session.compacted", properties: {
    sessionID: "session-9",
  } } as any });
  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-9",
    part: { type: "step-finish", sessionID: "session-9", messageID: "msg-1" },
  } } as any });
  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-9",
    part: { type: "compaction", sessionID: "session-9", messageID: "msg-2", auto: true },
  } } as any });
  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-9",
    part: { type: "agent", sessionID: "session-9", messageID: "msg-3", name: "build" },
  } } as any });
  await plugin["chat.params"]?.({
    sessionID: "session-9",
    agent: "build",
    model: { providerID: "openai", id: "gpt", limit: {}, cost: {} },
  } as any, { temperature: 0, topP: 1 } as any);

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps session status when it carries a message", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "session.status", properties: {
    sessionID: "session-10",
    status: { type: "error", attempt: 2, message: "provider timeout" },
  } } as any });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  expect(observations).toHaveLength(1);
  expect(observations[0].hookType).toBe("session_status");
  expect(observations[0].data).toEqual({
    status_type: "error",
    attempt: 2,
    message: "provider timeout",
  });
});

test("skips empty reasoning and retry parts", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-11",
    part: { type: "reasoning", sessionID: "session-11", messageID: "msg-1", text: "" },
  } } as any });
  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-11",
    part: { type: "retry", sessionID: "session-11", messageID: "msg-2", attempt: 2 },
  } } as any });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps reasoning and retry parts with content", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await AgentmemoryCapturePlugin({ worktree: process.cwd(), directory: process.cwd() } as any);

  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-12",
    part: { type: "reasoning", sessionID: "session-12", messageID: "msg-1", text: "  root cause hypothesis  " },
  } } as any });
  await plugin.event?.({ event: { type: "message.part.updated", properties: {
    sessionID: "session-12",
    part: { type: "retry", sessionID: "session-12", messageID: "msg-2", attempt: 2, error: "  timeout  " },
  } } as any });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  expect(observations).toHaveLength(2);
  expect(observations[0].hookType).toBe("reasoning");
  expect(observations[0].data.text).toBe("root cause hypothesis");
  expect(observations[1].hookType).toBe("retry_attempt");
  expect(observations[1].data.error).toBe("timeout");
});
