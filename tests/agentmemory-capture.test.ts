import { afterEach, expect, mock, test } from "bun:test";
import { redactRecord, redactText, sliceCapture } from "../opencode/plugins/agentmemory-capture/privacy";
import { transportAllowed } from "../opencode/plugins/agentmemory-capture/transport";

mock.module("@opencode/plugin", () => ({ Plugin: { define: (plugin: any) => plugin } }));

const originalFetch = globalThis.fetch;
const originalError = console.error;
const envKeys = ["AGENTMEMORY_URL", "AGENTMEMORY_SECRET", "AGENTMEMORY_PROJECT_NAME", "OPENCODE_AGENTMEMORY_DEBUG"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const cleanups: Array<() => Promise<void>> = [];
let moduleId = 0;

// Resuming the generator after yield acknowledges that the consumer awaited its handler.
// Unlike a microtask flush, emit therefore also waits for nested fetch/json awaits.
function contextFor() {
  type Pending = { event: any; done: () => void };
  const events: Pending[] = [];
  let wake: ((pending: Pending | undefined) => void) | undefined;
  let subscriptionSignal: AbortSignal | undefined;
  const hooks = new Map<string, (event: any) => Promise<void> | void>();
  const toolHooks = new Map<string, (event: any) => Promise<void> | void>();
  const context = {
    location: { directory: process.cwd() },
    config: {},
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      subscriptionSignal = signal;
      const abort = () => { wake?.(undefined); wake = undefined; };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (!signal.aborted) {
          const pending = events.shift() ?? await new Promise<Pending | undefined>((resolve) => { wake = resolve; });
          wake = undefined;
          if (!pending) break;
          try { yield pending.event; } finally { pending.done(); }
        }
      } finally {
        signal.removeEventListener("abort", abort);
        for (const pending of events.splice(0)) pending.done();
      }
    } },
    session: { hook: async (name: string, callback: any) => {
      hooks.set(name, callback);
      return { dispose: async () => { hooks.delete(name); } };
    } },
    tool: { hook: async (name: string, callback: any) => {
      toolHooks.set(name, callback);
      return { dispose: async () => { toolHooks.delete(name); } };
    } },
  };
  return {
    context,
    hooks,
    toolHooks,
    get signal() { return subscriptionSignal; },
    emit(event: any) {
      return new Promise<void>((done) => {
        const pending = { event, done };
        if (wake) { const resolve = wake; wake = undefined; resolve(pending); }
        else events.push(pending);
      });
    },
    async prompt(sessionID: string, text: string, extra: any = {}) {
      const hook = hooks.get("prompt");
      expect(hook).toBeDefined();
      await hook!({ sessionID, prompt: { text }, ...extra });
    },
    async modelContext(sessionID: string) {
      const event = { sessionID, system: [] as Array<{ type: string; text: string }>, messages: [], tools: {}, options: {} };
      const hook = hooks.get("context");
      expect(hook).toBeDefined();
      await hook!(event);
      return event.system.map((part) => part.text);
    },
  };
}

async function setup(url = "http://localhost:3111") {
  process.env.AGENTMEMORY_URL = url;
  process.env.AGENTMEMORY_SECRET = "test-only-secret";
  delete process.env.AGENTMEMORY_PROJECT_NAME;
  delete process.env.OPENCODE_AGENTMEMORY_DEBUG;
  const { AgentmemoryCapturePlugin } = await import(`../opencode/plugins/agentmemory-capture/index.ts?test=${++moduleId}`);
  const harness = contextFor();
  const cleanup = await (AgentmemoryCapturePlugin as any).setup(harness.context);
  cleanups.push(async () => {
    await cleanup();
    expect(harness.signal?.aborted).toBe(true);
  });
  return harness;
}

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test("correlates permission replies with the permission prompt context", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "permission.asked", properties: {
    id: "per-1",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["git status", "git show *"],
    metadata: { token: "private" },
  } });
  await plugin.emit({ type: "permission.replied", properties: {
    requestID: "per-1",
    sessionID: "session-1",
    reply: "once",
  } });

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

test("ends a session from the session-end command and ignores later capture", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "command.executed", properties: {
    name: "session-end",
    sessionID: "session-ended",
    arguments: "",
  } });
  await plugin.prompt("session-ended", "after end");

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/session/end")).map((request) => request.body))
    .toEqual([{ sessionId: "session-ended" }]);
  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("skips permission replies without prompt context", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "permission.replied", properties: {
    requestID: "missing",
    sessionID: "session-2",
    reply: "once",
  } });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("correlates removed messages with the last message update", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "message.updated", properties: {
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
  } });
  await plugin.emit({ type: "message.removed", properties: {
    sessionID: "session-3",
    messageID: "msg-1",
  } });

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
  const plugin = await setup();

  await plugin.emit({ type: "message.updated", properties: {
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
  } });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps assistant messages with errors", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "message.updated", properties: {
    sessionID: "session-assistant-error",
    info: {
      id: "msg-error",
      sessionID: "session-assistant-error",
      role: "assistant",
      modelID: "model-1",
      providerID: "provider-1",
      error: { message: "provider timeout" },
    },
  } });

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
  const plugin = await setup();

  await plugin.emit({ type: "message.removed", properties: {
    sessionID: "session-4",
    messageID: "missing",
  } });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("skips empty agentmemory search tool results", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "message.part.updated", properties: {
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
  } });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps non-empty agentmemory search tool results", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "message.part.updated", properties: {
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
  } });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  expect(observations).toHaveLength(1);
  expect(observations[0].hookType).toBe("post_tool_use");
  expect(observations[0].data.tool_name).toBe("agentmemory_memory_recall");
});

test("skips session updates even with titles or change summaries", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "session.updated", properties: {
    sessionID: "session-7",
    info: {
      id: "session-7",
      title: "Update agentmemory capture",
      summary: {
        files: ["register_defs.go", "oper_def_uninstall_node.go", "backend/AGENTS.md"],
      },
    },
  } });
  await plugin.emit({ type: "session.updated", properties: {
    info: {
      id: "session-7",
      title: "Update agentmemory capture",
      summary: { additions: 2, deletions: 1, files: 1 },
    },
  } });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps session diffs that include changed line counts", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "session.diff", properties: {
    sessionID: "session-8",
    diff: [
      { file: "backend/register_defs.go", additions: 2, deletions: 1 },
    ],
  } });

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
  const plugin = await setup();

  await plugin.emit({ type: "session.status", properties: {
    sessionID: "session-9",
    status: { type: "idle" },
  } });
  await plugin.emit({ type: "session.compacted", properties: {
    sessionID: "session-9",
  } });
  await plugin.emit({ type: "message.part.updated", properties: {
    sessionID: "session-9",
    part: { type: "step-finish", sessionID: "session-9", messageID: "msg-1" },
  } });
  await plugin.emit({ type: "message.part.updated", properties: {
    sessionID: "session-9",
    part: { type: "compaction", sessionID: "session-9", messageID: "msg-2", auto: true },
  } });
  await plugin.emit({ type: "message.part.updated", properties: {
    sessionID: "session-9",
    part: { type: "agent", sessionID: "session-9", messageID: "msg-3", name: "build" },
  } });
  await plugin.modelContext("session-9");

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps session status when it carries a message", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "session.status", properties: {
    sessionID: "session-10",
    status: { type: "error", attempt: 2, message: "provider timeout" },
  } });

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
  const plugin = await setup();

  await plugin.emit({ type: "message.part.updated", properties: {
    sessionID: "session-11",
    part: { type: "reasoning", sessionID: "session-11", messageID: "msg-1", text: "" },
  } });
  await plugin.emit({ type: "message.part.updated", properties: {
    sessionID: "session-11",
    part: { type: "retry", sessionID: "session-11", messageID: "msg-2", attempt: 2 },
  } });

  expect(requests.filter((request) => request.url.endsWith("/agentmemory/observe"))).toEqual([]);
});

test("keeps reasoning and retry parts with content", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();

  await plugin.emit({ type: "message.part.updated", properties: {
    sessionID: "session-12",
    part: { type: "reasoning", sessionID: "session-12", messageID: "msg-1", text: "  root cause hypothesis  " },
  } });
  await plugin.emit({ type: "message.part.updated", properties: {
    sessionID: "session-12",
    part: { type: "retry", sessionID: "session-12", messageID: "msg-2", attempt: 2, error: "  timeout  " },
  } });

  const observations = requests
    .filter((request) => request.url.endsWith("/agentmemory/observe"))
    .map((request) => request.body);
  expect(observations).toHaveLength(2);
  expect(observations[0].hookType).toBe("reasoning");
  expect(observations[0].data.text).toBe("root cause hypothesis");
  expect(observations[1].hookType).toBe("retry_attempt");
  expect(observations[1].data.error).toBe("timeout");
});

test("redacts nested compound secret keys without changing correlation IDs or source records", () => {
  const source = {
    sessionId: "session-private",
    call_id: "call-private",
    tool_call_id: "tool-private",
    nested: [{
      serviceApiKey: "api-key-value",
      service_token: "token-value",
      "db.password": "password-value",
      "client-secret": "secret-value",
      authorization: "authorization-value",
      credentials: { user: "credential-user", pass: "credential-pass" },
      summary: "non-secret content",
    }],
  };
  const redacted = redactRecord(source);
  expect(redacted).toMatchObject({
    sessionId: "session-private",
    call_id: "call-private",
    tool_call_id: "tool-private",
    nested: [{
      serviceApiKey: "[REDACTED_SECRET]",
      service_token: "[REDACTED_SECRET]",
      "db.password": "[REDACTED_SECRET]",
      "client-secret": "[REDACTED_SECRET]",
      authorization: "[REDACTED_SECRET]",
      credentials: "[REDACTED_SECRET]",
      summary: "non-secret content",
    }],
  });
  for (const secret of ["api-key-value", "token-value", "password-value", "secret-value", "authorization-value", "credential-user", "credential-pass"]) {
    expect(JSON.stringify(redacted)).not.toContain(secret);
  }
  expect(source.nested[0].serviceApiKey).toBe("api-key-value");
  expect(source.nested[0].credentials.pass).toBe("credential-pass");
});

test("redacts Bearer, URL credentials and complete or unterminated PEM before capture truncation", () => {
  const text = [
    "Authorization: Bearer bearer-fixture-value",
    "https://fixture-user:fixture-password@example.test/path",
    "-----BEGIN PRIVATE KEY-----\nfixture-pem-value\n-----END PRIVATE KEY-----",
    "safe summary",
  ].join("\n");
  const safe = redactText(text);
  for (const secret of ["bearer-fixture-value", "fixture-user", "fixture-password", "fixture-pem-value"]) {
    expect(safe).not.toContain(secret);
  }
  expect(safe).toContain("example.test/path");
  expect(safe).toContain("safe summary");
  expect(redactText("-----BEGIN RSA PRIVATE KEY-----\nunterminated-pem-value")).not.toContain("unterminated-pem-value");

  // Truncating first would preserve the credential prefix without its closing delimiter.
  expect(sliceCapture(`Bearer ${"a".repeat(200)}`, 24)).not.toContain("aaaa");
  expect(sliceCapture(`https://fixture-user:${"p".repeat(200)}@example.test`, 40)).not.toContain("fixture-user");
  expect(sliceCapture({ serviceApiKey: "key-prefix-".repeat(200) }, 40)).not.toContain("key-prefix");
});

test("text redaction remains stable across capture and transport passes", () => {
  const text = 'Authorization: Bearer fixture-secret\napi_key=[REDACTED_SECRET]\nclientSecret="fixture-client-secret"';
  const once = redactText(text);
  expect(redactText(once)).toBe(once);
  expect(redactText('{"authorization":{"scheme":"Bearer","detail":"safe"},"summary":"keep"}'))
    .toBe('{"authorization":{"scheme":"Bearer","detail":"safe"},"summary":"keep"}');
  expect(once).not.toContain("fixture-secret");
  expect(once).not.toContain("fixture-client-secret");
  expect(redactText("safe <private>outer <private>inner-secret</private> outer-secret</private> tail"))
    .toBe("safe [REDACTED_SECRET] tail");
  expect(redactText("safe <private>unterminated-secret")).toBe("safe [REDACTED_SECRET]");
  expect(redactRecord({ privateKey: "private-value", PRIVATE_KEY: "other-private-value" }))
    .toEqual({ privateKey: "[REDACTED_SECRET]", PRIVATE_KEY: "[REDACTED_SECRET]" });
});

test("redacts nested JSON strings without consuming enclosing object or array boundaries", () => {
  const text = '{"config":{"password":"fixture-password"},"items":[{"clientSecret":"fixture-client"}],"summary":"keep"}';
  const once = redactText(text);
  expect(once).not.toContain("fixture-password");
  expect(once).not.toContain("fixture-client");
  expect(redactText(once)).toBe(once);
  expect(JSON.parse(once)).toMatchObject({ config: { password: "[REDACTED_SECRET]" }, summary: "keep" });
});

test("capture truncation preserves Unicode boundaries and handles absent or unserializable values", () => {
  expect(sliceCapture("中😀文", 2)).toBe("中");
  expect(sliceCapture("中😀文", 3)).toBe("中😀");
  expect(sliceCapture("😀😀", 3)).toBe("😀");
  expect(sliceCapture("中😀文", 4)).toBe("中😀文");
  expect(sliceCapture(null, 10)).toBe("");
  const cyclic: any = {};
  cyclic.self = cyclic;
  expect(sliceCapture(cyclic, 10)).toBe("");
});

test("redacts prompt, tool input/output and nested metadata on the actual outbound payload", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const plugin = await setup();
  const prompt = [
    "retain prompt context",
    '{"config":{"password":"nested-prompt-secret"}}',
    "Bearer prompt-bearer-value",
    "https://prompt-user:prompt-password@example.test/path",
    "-----BEGIN PRIVATE KEY-----\nprompt-pem-value\n-----END PRIVATE KEY-----",
    `Bearer ${"prompt-long-secret-".repeat(1000)}`,
  ].join("\n");
  await plugin.prompt("session-redaction", prompt);
  await plugin.emit({ type: "message.part.updated", properties: {
    part: {
      type: "tool",
      sessionID: "session-redaction",
      callID: "call-redaction",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: "safe.ts", connection: { serviceApiKey: "input-key-value" } },
        output: `Bearer ${"output-secret-".repeat(1000)}`,
        metadata: { nested: [{ clientSecret: "metadata-secret-value", detail: "Bearer metadata-bearer-value" }] },
      },
    },
  } });
  const observations = requests.filter((request) => request.url.endsWith("/observe")).map((request) => request.body);
  expect(observations).toHaveLength(2);
  expect(observations[0]).toMatchObject({ sessionId: "session-redaction", hookType: "prompt_submit" });
  expect(observations[0].data.prompt).toContain("retain prompt context");
  expect(observations[0].data.prompt.length).toBeLessThanOrEqual(8000);
  expect(prompt).toContain("prompt-bearer-value");
  expect(observations[1]).toMatchObject({ sessionId: "session-redaction", data: { call_id: "call-redaction", tool_name: "read" } });
  expect(observations[1].data.tool_input).toContain("safe.ts");
  expect(observations[1].data.metadata.nested).toHaveLength(1);
  expect(observations[1].data.tool_output.length).toBeLessThanOrEqual(8000);
  for (const secret of ["nested-prompt-secret", "prompt-bearer-value", "prompt-user", "prompt-password", "prompt-pem-value", "prompt-long-secret-", "input-key-value", "output-secret-", "metadata-secret-value", "metadata-bearer-value"]) {
    expect(JSON.stringify(requests)).not.toContain(secret);
  }
});

test("preserves protocol IDs only at their owning payload roots, not nested metadata", async () => {
  const observations: any[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/observe")) observations.push(JSON.parse(String(init?.body)));
    return Response.json({});
  }) as typeof fetch;
  const plugin = await setup();
  const sessionID = "Bearer session-protocol-id";
  await plugin.emit({ type: "message.part.updated", properties: { part: {
    type: "tool", sessionID, callID: "Bearer call-protocol-id", tool: "read",
    state: { status: "completed", input: {}, output: "safe output", metadata: {
      call_id: "Bearer nested-call-secret", sessionId: "Bearer nested-session-secret",
    } },
  } } });
  await plugin.emit({ type: "message.updated", properties: { info: {
    id: "Bearer message-protocol-id", sessionID, role: "assistant",
    parentID: "Bearer parent-protocol-id", modelID: "Bearer model-protocol-id",
    providerID: "Bearer provider-protocol-id", error: { message: "fixture error" },
  } } });
  await plugin.emit({ type: "message.part.updated", properties: { part: {
    type: "subtask", id: "Bearer subtask-protocol-id", sessionID, prompt: "safe prompt",
  } } });
  await plugin.emit({ type: "permission.asked", properties: {
    id: "Bearer permission-protocol-id", sessionID, permission: "read", patterns: ["safe.ts"], callID: "Bearer permission-call-id",
  } });
  await plugin.emit({ type: "permission.replied", properties: {
    requestID: "Bearer permission-protocol-id", sessionID, reply: "once",
  } });
  expect(observations).toHaveLength(5);
  expect(observations.every((observation) => observation.sessionId === sessionID)).toBe(true);
  expect(observations.find((observation) => observation.hookType === "post_tool_use").data.call_id).toBe("Bearer call-protocol-id");
  expect(observations.find((observation) => observation.hookType === "assistant_message").data).toMatchObject({
    messageID: "Bearer message-protocol-id", parentID: "Bearer parent-protocol-id",
    modelID: "Bearer model-protocol-id", providerID: "Bearer provider-protocol-id",
  });
  expect(observations.find((observation) => observation.hookType === "subagent_start").data.subtask_id).toBe("Bearer subtask-protocol-id");
  expect(observations.find((observation) => observation.hookType === "permission_replied").data).toMatchObject({
    permission_id: "Bearer permission-protocol-id", tool_call_id: "Bearer permission-call-id",
  });
  expect(JSON.stringify(observations)).not.toContain("nested-call-secret");
  expect(JSON.stringify(observations)).not.toContain("nested-session-secret");
});

for (const url of ["http://localhost:3111", "http://127.0.0.1:3111", "http://127.23.4.5:3111", "http://[::1]:3111", "https://localhost:3111", "https://memory.example.test"]) {
  test(`allows safe transport for ${url}`, () => {
    expect(transportAllowed(url)).toBe(true);
  });
}

for (const url of ["http://memory.example.test", "http://localhost.example.test", "http://127.0.0.1.example.test", "http://192.168.1.1", "ftp://localhost", "file:///etc/passwd", "not a url", "https://", ""]) {
  test(`blocks unsafe or malformed transport ${JSON.stringify(url)}`, () => {
    expect(transportAllowed(url)).toBe(false);
  });
}

for (const url of ["http://127.0.0.1:3111", "https://memory.example.test"]) {
  test(`post and postJson disable redirects with safe transport ${url}`, async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const plugin = await setup(url);
    await plugin.prompt("session-transport", "safe prompt");
    await plugin.modelContext("session-transport");
    expect(requests.some((request) => request.url.endsWith("/observe"))).toBe(true);
    expect(requests.some((request) => request.url.endsWith("/context"))).toBe(true);
    for (const request of requests) {
      expect(request.url.startsWith(url)).toBe(true);
      expect(request.init.redirect).toBe("error");
    }
  });
}

for (const url of ["http://memory.example.test", "not a url"]) {
  test(`post and postJson block ${JSON.stringify(url)} and warn only once`, async () => {
    const requests: string[] = [];
    const warnings: unknown[][] = [];
    console.error = (...args) => { warnings.push(args); };
    globalThis.fetch = (async (url) => {
      requests.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const plugin = await setup(url);
    await plugin.prompt("session-blocked", "first prompt");
    await plugin.modelContext("session-blocked");
    await plugin.prompt("session-blocked", "second prompt");
    await plugin.modelContext("session-blocked");
    expect(requests).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain("test-only-secret");
  });
}

test("preserves the parent session identity on session start while redacting its title", async () => {
  const starts: any[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/session/start")) starts.push(JSON.parse(String(init?.body)));
    return Response.json({});
  }) as typeof fetch;
  const plugin = await setup();
  await plugin.emit({ type: "session.created", properties: { info: {
    id: "Bearer child-session-id", parentID: "Bearer parent-session-id", title: "Bearer title-secret",
  } } });
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ sessionId: "Bearer child-session-id", parentID: "Bearer parent-session-id" });
  expect(starts[0].title).not.toContain("title-secret");
});

test("refreshes a resumed continuation's cached context on its first new prompt", async () => {
  let attempts = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/context")) return Response.json({ context: `resumed-context-${++attempts}` });
    return Response.json({});
  }) as typeof fetch;
  const plugin = await setup();
  expect(await plugin.modelContext("resumed-session")).toContain("resumed-context-1");
  await plugin.prompt("resumed-session", "new task after reload");
  const refreshed = await plugin.modelContext("resumed-session");
  expect(refreshed).toContain("resumed-context-2");
  expect(refreshed).not.toContain("resumed-context-1");
  expect(await plugin.modelContext("resumed-session")).toContain("resumed-context-2");
  expect(attempts).toBe(2);
});

test("attaches instructions and cached start context to every model call without refetching", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    return Response.json(String(url).endsWith("/session/start") ? { context: "cached start context" } : {});
  }) as typeof fetch;
  const plugin = await setup();
  await plugin.emit({ type: "session.created", properties: { info: { id: "session-cached" } } });
  await plugin.prompt("session-cached", "first admitted prompt");
  for (let i = 0; i < 3; i++) {
    const system = await plugin.modelContext("session-cached");
    expect(system.filter((text) => text.includes("<agentmemory-instructions>"))).toHaveLength(1);
    expect(system.filter((text) => text === "cached start context")).toHaveLength(1);
  }
  expect(requests.filter((url) => url.endsWith("/session/start"))).toHaveLength(1);
  expect(requests.filter((url) => url.endsWith("/context"))).toHaveLength(0);
});

test("caches a successful empty context until the next prompt", async () => {
  let attempts = 0;
  globalThis.fetch = (async (url) => {
    if (String(url).endsWith("/context")) {
      attempts++;
      return Response.json({ context: attempts === 1 ? "" : "new prompt context" });
    }
    return Response.json({});
  }) as typeof fetch;
  const plugin = await setup();
  await plugin.prompt("session-empty-context", "first prompt");
  for (let i = 0; i < 2; i++) {
    const system = await plugin.modelContext("session-empty-context");
    expect(system).toHaveLength(1);
    expect(system[0]).toContain("<agentmemory-instructions>");
  }
  expect(attempts).toBe(1);
  await plugin.prompt("session-empty-context", "next prompt");
  expect(await plugin.modelContext("session-empty-context")).toContain("new prompt context");
  expect(attempts).toBe(2);
});

test("refreshes retrieved context for each prompt and reuses it on tool continuations", async () => {
  const contextRequests: any[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/context")) {
      contextRequests.push(JSON.parse(String(init?.body)));
      return Response.json({ context: `retrieval-${contextRequests.length}` });
    }
    return Response.json({});
  }) as typeof fetch;
  const plugin = await setup();
  await plugin.prompt("session-refresh", "first task");
  expect(await plugin.modelContext("session-refresh")).toContain("retrieval-1");
  expect(await plugin.modelContext("session-refresh")).toContain("retrieval-1");
  expect(contextRequests).toHaveLength(1);
  await plugin.prompt("session-refresh", "second task");
  const refreshed = await plugin.modelContext("session-refresh");
  expect(refreshed).toContain("retrieval-2");
  expect(refreshed).not.toContain("retrieval-1");
  expect(await plugin.modelContext("session-refresh")).toContain("retrieval-2");
  expect(contextRequests).toHaveLength(2);
  expect(contextRequests.every((request) => request.sessionId === "session-refresh")).toBe(true);
});

for (const failure of ["network", "http", "missing context"]) {
  test(`retries context retrieval after ${failure} failure without suppressing instructions`, async () => {
    let attempts = 0;
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/context")) {
        attempts++;
        if (attempts === 1) {
          if (failure === "network") throw new Error("fixture network failure");
          if (failure === "http") return Response.json({}, { status: 503 });
          return Response.json({});
        }
        return Response.json({ context: "retried context" });
      }
      return Response.json({});
    }) as typeof fetch;
    const plugin = await setup();
    await plugin.prompt("session-retry-context", "recover retrieval");
    const first = await plugin.modelContext("session-retry-context");
    expect(first.filter((text) => text.includes("<agentmemory-instructions>"))).toHaveLength(1);
    expect(first).not.toContain("retried context");
    for (let i = 0; i < 2; i++) {
      const system = await plugin.modelContext("session-retry-context");
      expect(system.filter((text) => text.includes("<agentmemory-instructions>"))).toHaveLength(1);
      expect(system).toContain("retried context");
    }
    expect(attempts).toBe(2);
  });
}

test("enrichment carries each session's current project rather than the last active session", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ context: "fixture context" });
  }) as typeof fetch;
  const plugin = await setup();
  await plugin.emit({ type: "session.created", properties: { info: { id: "session-alpha", directory: "/capture-project-alpha" } } });
  await plugin.emit({ type: "session.created", properties: { info: { id: "session-beta", directory: "/capture-project-beta" } } });
  const before = plugin.toolHooks.get("execute.before");
  expect(before).toBeDefined();
  for (const sessionID of ["session-alpha", "session-beta"]) {
    await before!({ sessionID, tool: "read", input: { filePath: `${sessionID}.ts` } });
    expect(await plugin.modelContext(sessionID)).toContain("fixture context");
  }
  const enrich = requests.filter((request) => request.url.endsWith("/enrich")).map((request) => request.body);
  expect(enrich).toEqual([
    { sessionId: "session-alpha", project: "capture-project-alpha", files: ["session-alpha.ts"], toolName: "enrich_inject" },
    { sessionId: "session-beta", project: "capture-project-beta", files: ["session-beta.ts"], toolName: "enrich_inject" },
  ]);
});
