import { expect, test } from "bun:test";
import { AgentsMDReminderPlugin } from "../opencode/plugins/agents-md-reminder/index";

function contextFor(logs: any[]) {
  const events: any[] = [];
  const waiters: Array<(result: IteratorResult<any>) => void> = [];
  const hooks = new Map<string, (event: any) => Promise<void> | void>();
  return {
    context: {
      event: { subscribe: async function* () {
        while (true) {
          const event = events.shift() ?? await new Promise<any>((resolve) => waiters.push(resolve));
          yield event;
        }
      } },
      session: { hook: async (name: string, callback: any) => hooks.set(name, callback) },
      app: {
        log: async ({ body }: { body: any }) => {
          logs.push(body);
          return {};
        },
      },
    },
    hooks,
    emit(event: any) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else events.push(event);
    },
  };
}

async function setup(logs: any[]) {
  const harness = contextFor(logs);
  await (AgentsMDReminderPlugin as any).setup(harness.context);
  return harness;
}

async function call(plugin: any, sessionID: string, output: { system: any[] }) {
  await plugin.hooks.get("context")?.({ sessionID, system: output.system });
}

test("reminds on the tenth normal model call and resets the interval", async () => {
  const logs: any[] = [];
  const plugin = await setup(logs);
  plugin.emit({ type: "session.created", properties: { info: { id: "session-1" } } });
  await Promise.resolve();

  for (let i = 0; i < 9; i++) await call(plugin, "session-1", { system: [] });
  const output = { system: [] as string[] };
  await call(plugin, "session-1", output);

  expect(output.system).toHaveLength(1);
  expect(output.system[0].text).toContain("全局 AGENTS.md");
  expect(logs).toMatchObject([{ trigger: "periodic", callsSinceReminder: 0 }]);
  const next = { system: [] as string[] };
  await call(plugin, "session-1", next);
  expect(next.system).toEqual([]);
});

test("reminds once after compaction without counting the compaction call", async () => {
  const logs: any[] = [];
  const plugin = await setup(logs);
  plugin.emit({ type: "session.created", properties: { info: { id: "session-2" } } });
  await Promise.resolve();
  await plugin.hooks.get("compaction")?.({ sessionID: "session-2" });
  const summary = { system: [] as string[] };
  await call(plugin, "session-2", summary);
  expect(summary.system).toEqual([]);
  plugin.emit({ type: "session.compacted", properties: { sessionID: "session-2" } });
  await Promise.resolve();

  const output = { system: [] as string[] };
  await call(plugin, "session-2", output);
  expect(output.system).toHaveLength(1);
  expect(logs).toMatchObject([{ trigger: "after_compaction" }]);

  const next = { system: [] as string[] };
  await call(plugin, "session-2", next);
  expect(next.system).toEqual([]);
});

test("isolates session counters and does not inject duplicate reminders", async () => {
  const logs: any[] = [];
  const plugin = await setup(logs);
  plugin.emit({ type: "session.created", properties: { info: { id: "session-3" } } });
  plugin.emit({ type: "session.created", properties: { info: { id: "session-4" } } });
  await Promise.resolve();

  for (let i = 0; i < 9; i++) await call(plugin, "session-3", { system: [] });
  const first = { system: [] as string[] };
  await call(plugin, "session-3", first);
  const second = { system: [] as string[] };
  await call(plugin, "session-4", second);

  expect(first.system).toHaveLength(1);
  expect(second.system).toEqual([]);
  expect(logs).toHaveLength(1);
});

test("continues the model call when reminder logging fails", async () => {
  const plugin = await setup([]);
  plugin.emit({ type: "session.created", properties: { info: { id: "session-5" } } });
  await Promise.resolve();
  for (let i = 0; i < 9; i++) await call(plugin, "session-5", { system: [] });

  const output = { system: [] as string[] };
  await expect(call(plugin, "session-5", output)).resolves.toBeUndefined();
  expect(output.system).toHaveLength(1);
});
