import { afterEach, expect, test } from "bun:test";
import { SequentialThinkingReminderPlugin } from "../opencode/plugins/sequential-thinking-reminder/index";

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

type Harness = {
  context: any;
  hooks: Map<string, (event: any) => Promise<void> | void>;
  toolHooks: Map<string, (event: any) => Promise<void> | void>;
  rpcEvents: Array<{ name: string; data: any }>;
  logs: any[];
  emit(event: any): void;
};

function contextFor(): Harness {
  const events: any[] = [];
  const waiters: Array<(event: any) => void> = [];
  const hooks = new Map<string, (event: any) => Promise<void> | void>();
  const toolHooks = new Map<string, (event: any) => Promise<void> | void>();
  const rpcEvents: Array<{ name: string; data: any }> = [];
  const logs: any[] = [];
  return {
    context: {
      app: {
        log: async ({ body }: { body: any }) => logs.push(body),
      },
      event: {
        subscribe: async function* ({ signal }: { signal?: AbortSignal } = {}) {
          while (!signal?.aborted) {
            const event =
              events.shift() ??
              (await new Promise<any>((resolve) => {
                const waiter = (value: any) => resolve(value);
                waiters.push(waiter);
                signal?.addEventListener("abort", () => resolve(null), {
                  once: true,
                });
              }));
            if (event === null || signal?.aborted) return;
            yield event;
          }
        },
      },
      session: {
        hook: async (name: string, callback: any) => hooks.set(name, callback),
      },
      tool: {
        hook: async (name: string, callback: any) =>
          toolHooks.set(name, callback),
      },
      rpc: {
        register: async () => ({
          events: {
            emit: async (name: string, data: any) =>
              rpcEvents.push({ name, data }),
          },
        }),
      },
    },
    hooks,
    toolHooks,
    rpcEvents,
    logs,
    emit(event: any) {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else events.push(event);
    },
  };
}

async function setup(): Promise<Harness> {
  const harness = contextFor();
  cleanup = await (SequentialThinkingReminderPlugin as any).setup(
    harness.context,
  );
  return harness;
}

async function contextCall(harness: Harness, sessionID: string) {
  const output = { system: [] as any[] };
  await harness.hooks.get("context")?.({ sessionID, system: output.system });
  return output;
}

async function flushEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function reasoningEvent(
  sessionID: string,
  messageID: string,
  partID: string,
  complete = true,
) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        sessionID,
        messageID,
        id: partID,
        type: "reasoning",
        text: `thought ${partID}`,
        time: complete ? { completed: 1 } : undefined,
      },
    },
  };
}

function messageFinished(sessionID: string, messageID: string) {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        finish: "stop",
      },
    },
  };
}

async function emitThought(
  harness: Harness,
  sessionID: string,
  messageID: string,
  partID: string,
  complete = true,
) {
  harness.emit(reasoningEvent(sessionID, messageID, partID, complete));
  await flushEvents();
  harness.emit(messageFinished(sessionID, messageID));
  await flushEvents();
}

test("shows one active toast event and reminds after two completed thoughts", async () => {
  const harness = await setup();
  await contextCall(harness, "session-1");
  expect(harness.rpcEvents).toEqual([
    {
      name: "active",
      data: {
        sessionID: "session-1",
        message: "Monitoring reasoning thoughts and sequential-thinking usage.",
      },
    },
  ]);
  expect(harness.logs).toContainEqual({
    service: "sequential-thinking-reminder",
    level: "debug",
    message: "Sequential-thinking guard active",
    sessionID: "session-1",
    trigger: "active",
  });

  await emitThought(harness, "session-1", "message-1", "part-1");
  await emitThought(harness, "session-1", "message-2", "part-2");
  const output = await contextCall(harness, "session-1");

  expect(output.system).toHaveLength(1);
  expect(output.system[0].text).toContain("completed 2 reasoning thoughts");
  expect(harness.rpcEvents.at(-1)).toEqual({
    name: "reminder",
    data: {
      sessionID: "session-1",
      message:
        "The agent has completed 2 reasoning thoughts without using the sequential-thinking tool. Use sequential-thinking before continuing.",
      thoughtCount: 2,
      level: 1,
    },
  });
  expect(harness.logs).toContainEqual({
    service: "sequential-thinking-reminder",
    level: "info",
    message: "Sequential-thinking reminder emitted",
    sessionID: "session-1",
    trigger: "reminder",
    thoughtCount: 2,
    reminderLevel: 1,
  });

  await contextCall(harness, "session-1");
  expect(
    harness.rpcEvents.filter((event) => event.name === "active"),
  ).toHaveLength(1);
});

test("deduplicates streaming updates for the same reasoning part", async () => {
  const harness = await setup();
  harness.emit(reasoningEvent("session-2", "message-1", "part-1", false));
  await flushEvents();
  harness.emit(reasoningEvent("session-2", "message-1", "part-1", true));
  await flushEvents();
  harness.emit(messageFinished("session-2", "message-1"));
  await flushEvents();
  await emitThought(harness, "session-2", "message-2", "part-2");

  const output = await contextCall(harness, "session-2");
  expect(output.system).toHaveLength(1);
  expect(output.system[0].text).toContain("completed 2 reasoning thoughts");
});

test("resets the thought count after a successful sequential-thinking call", async () => {
  const harness = await setup();
  await emitThought(harness, "session-3", "message-1", "part-1");
  await emitThought(harness, "session-3", "message-2", "part-2");
  await harness.toolHooks.get("execute.after")?.({
    sessionID: "session-3",
    tool: "sequential-thinking_sequentialthinking",
    status: "completed",
  });

  const output = await contextCall(harness, "session-3");
  expect(output.system).toEqual([]);
  expect(
    harness.rpcEvents.filter((event) => event.name === "reminder"),
  ).toHaveLength(0);
  expect(harness.logs).toContainEqual({
    service: "sequential-thinking-reminder",
    level: "debug",
    message: "Sequential-thinking counter reset",
    sessionID: "session-3",
    trigger: "successful_tool",
  });
});

test("does not reset after another tool or a failed sequential-thinking call", async () => {
  const harness = await setup();
  await emitThought(harness, "session-4", "message-1", "part-1");
  await emitThought(harness, "session-4", "message-2", "part-2");
  await harness.toolHooks.get("execute.after")?.({
    sessionID: "session-4",
    tool: "sequential-thinking_sequentialthinking",
    status: "error",
  });

  const output = await contextCall(harness, "session-4");
  expect(output.system).toHaveLength(1);
});

test("escalates at four thoughts and ignores sessions without reasoning parts", async () => {
  const harness = await setup();
  await contextCall(harness, "session-5");
  expect(
    harness.rpcEvents.filter((event) => event.name === "reminder"),
  ).toHaveLength(0);

  await emitThought(harness, "session-5", "message-1", "part-1");
  await emitThought(harness, "session-5", "message-2", "part-2");
  await contextCall(harness, "session-5");
  await emitThought(harness, "session-5", "message-3", "part-3");
  await emitThought(harness, "session-5", "message-4", "part-4");
  await contextCall(harness, "session-5");

  const reminders = harness.rpcEvents.filter(
    (event) => event.name === "reminder",
  );
  expect(reminders).toHaveLength(2);
  expect(reminders[1].data).toMatchObject({ thoughtCount: 4, level: 2 });
});

test("does not count an incomplete reasoning part until the assistant turn finishes", async () => {
  const harness = await setup();
  harness.emit(reasoningEvent("session-6", "message-1", "part-1", false));
  await flushEvents();
  await emitThought(harness, "session-6", "message-2", "part-2");

  const beforeFinish = await contextCall(harness, "session-6");
  expect(beforeFinish.system).toEqual([]);

  harness.emit(messageFinished("session-6", "message-1"));
  await flushEvents();
  const afterFinish = await contextCall(harness, "session-6");
  expect(afterFinish.system).toHaveLength(1);
});
