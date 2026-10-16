import { expect, test } from "bun:test";
import { AgentsMDReminderPlugin } from "../opencode/plugins/agents-md-reminder/index";

function clientFor(logs: any[]) {
  return {
    app: {
      log: async ({ body }: { body: any }) => {
        logs.push(body);
        return {};
      },
    },
  };
}

async function call(plugin: any, sessionID: string, output: { system: string[] }) {
  await plugin["experimental.chat.system.transform"]?.({ sessionID }, output);
}

test("reminds on the tenth normal model call and resets the interval", async () => {
  const logs: any[] = [];
  const plugin = await AgentsMDReminderPlugin({ client: clientFor(logs) } as any);
  await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-1" } } } } as any);

  for (let i = 0; i < 9; i++) await call(plugin, "session-1", { system: [] });
  const output = { system: [] as string[] };
  await call(plugin, "session-1", output);

  expect(output.system).toHaveLength(1);
  expect(output.system[0]).toContain("全局 AGENTS.md");
  expect(logs).toMatchObject([{ trigger: "periodic", callsSinceReminder: 0 }]);
  const next = { system: [] as string[] };
  await call(plugin, "session-1", next);
  expect(next.system).toEqual([]);
});

test("reminds once after compaction without counting the compaction call", async () => {
  const logs: any[] = [];
  const plugin = await AgentsMDReminderPlugin({ client: clientFor(logs) } as any);
  await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-2" } } } } as any);
  await plugin["experimental.session.compacting"]?.({ sessionID: "session-2" } as any, { context: [] } as any);
  const summary = { system: [] as string[] };
  await call(plugin, "session-2", summary);
  expect(summary.system).toEqual([]);
  await plugin.event?.({ event: { type: "session.compacted", properties: { sessionID: "session-2" } } } as any);

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
  const plugin = await AgentsMDReminderPlugin({ client: clientFor(logs) } as any);
  await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-3" } } } } as any);
  await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-4" } } } } as any);

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
  const plugin = await AgentsMDReminderPlugin({
    client: { app: { log: async () => { throw new Error("log failed"); } } },
  } as any);
  await plugin.event?.({ event: { type: "session.created", properties: { info: { id: "session-5" } } } } as any);
  for (let i = 0; i < 9; i++) await call(plugin, "session-5", { system: [] });

  const output = { system: [] as string[] };
  await expect(call(plugin, "session-5", output)).resolves.toBeUndefined();
  expect(output.system).toHaveLength(1);
});
