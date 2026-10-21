import { expect, test } from "bun:test";
import { MemoryActivationReminderPlugin } from "../opencode/plugins/memory-activation-reminder/index";

function skillEvent(sessionID: string, name: string) {
  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        type: "tool",
        sessionID,
        tool: "skill",
        state: { status: "completed", input: { name } },
      },
    },
  };
}

async function createHarness() {
  const toasts: any[] = [];
  const logs: any[] = [];
  const hooks: Record<string, (input: any, output?: any) => Promise<void>> = {};
  let nextEvent: ((result: IteratorResult<any>) => void) | undefined;
  const queuedEvents: any[] = [];
  let stopped = false;

  const iterator = {
    next(): Promise<IteratorResult<any>> {
      if (queuedEvents.length > 0) {
        return Promise.resolve({ value: queuedEvents.shift(), done: false });
      }
      if (stopped) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { nextEvent = resolve; });
    },
    return(): Promise<IteratorResult<any>> {
      stopped = true;
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  const client = {
    app: { log: async ({ body }: { body: any }) => { logs.push(body); return {}; } },
    tui: { showToast: async ({ body }: { body: any }) => { toasts.push(body); return {}; } },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => iterator }) },
    tool: { hook: async (name: string, callback: any) => { hooks[`tool:${name}`] = callback; } },
    session: { hook: async (name: string, callback: any) => { hooks[`session:${name}`] = callback; } },
  };

  const plugin = await MemoryActivationReminderPlugin.setup({ client } as any);

  return {
    hooks,
    logs,
    toasts,
    async emit(event: any) {
      if (nextEvent) {
        const resolve = nextEvent;
        nextEvent = undefined;
        resolve({ value: event, done: false });
      } else {
        queuedEvents.push(event);
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    async dispose() {
      await plugin?.();
      stopped = true;
    },
  };
}

async function loadSkill(harness: Awaited<ReturnType<typeof createHarness>>, sessionID: string, name: string) {
  await harness.emit(skillEvent(sessionID, name));
}

test("reminds after task skill when memory activation is missing", async () => {
  const harness = await createHarness();
  await loadSkill(harness, "session-1", "create-github-pr");
  await harness.hooks["tool:execute.before"]({ sessionID: "session-1", tool: "bash" });

  expect(harness.toasts).toHaveLength(1);
  expect(harness.toasts[0]).toMatchObject({ title: "Memory activation", variant: "warning" });
  expect(harness.toasts[0].message).toContain("create-github-pr");
  expect(harness.logs).toHaveLength(1);
  expect(harness.logs[0].service).toBe("memory-activation-reminder");
  await harness.dispose();
});

test("does not remind when memory activation skill clears pending state", async () => {
  const harness = await createHarness();
  await loadSkill(harness, "session-2", "review-pr");
  await loadSkill(harness, "session-2", "memory-activation");
  await harness.hooks["tool:execute.before"]({ sessionID: "session-2", tool: "bash" });

  expect(harness.toasts).toEqual([]);
  await harness.dispose();
});

test("injects one agent-visible system reminder for pending task skill", async () => {
  const harness = await createHarness();
  await loadSkill(harness, "session-6", "custom-opencode");
  const output = { system: [] as Array<{ type: string; text: string }> };

  await harness.hooks["session:context"]({ sessionID: "session-6", system: output.system });
  await harness.hooks["session:context"]({ sessionID: "session-6", system: output.system });

  expect(output.system).toHaveLength(1);
  expect(output.system[0].text).toContain("[Memory activation reminder]");
  expect(output.system[0].text).toContain("custom-opencode");
  await harness.dispose();
});

test("does not inject after memory activation clears pending state", async () => {
  const harness = await createHarness();
  await loadSkill(harness, "session-7", "custom-opencode");
  await loadSkill(harness, "session-7", "memory-activation");
  const output = { system: [] as Array<{ type: string; text: string }> };

  await harness.hooks["session:context"]({ sessionID: "session-7", system: output.system });

  expect(output.system).toEqual([]);
  await harness.dispose();
});

test("skips memory and reference skills", async () => {
  const harness = await createHarness();
  await loadSkill(harness, "session-3", "memory-discipline");
  await harness.hooks["tool:execute.before"]({ sessionID: "session-3", tool: "bash" });
  await loadSkill(harness, "session-3", "agentmemory-mcp-tools");
  await harness.hooks["tool:execute.before"]({ sessionID: "session-3", tool: "bash" });

  expect(harness.toasts).toEqual([]);
  await harness.dispose();
});

test("reminds only once per pending skill load", async () => {
  const harness = await createHarness();
  await loadSkill(harness, "session-4", "issue-from-idea");
  await harness.hooks["tool:execute.before"]({ sessionID: "session-4", tool: "read" });
  await harness.hooks["tool:execute.before"]({ sessionID: "session-4", tool: "bash" });

  expect(harness.toasts).toHaveLength(1);
  await harness.dispose();
});

test("allows memory recall tools before the reminder fires", async () => {
  const harness = await createHarness();
  await loadSkill(harness, "session-5", "custom-opencode");
  await harness.hooks["tool:execute.before"]({ sessionID: "session-5", tool: "agentmemory_memory_lesson_recall" });
  expect(harness.toasts).toEqual([]);

  await harness.hooks["tool:execute.before"]({ sessionID: "session-5", tool: "bash" });
  expect(harness.toasts).toHaveLength(1);
  await harness.dispose();
});
