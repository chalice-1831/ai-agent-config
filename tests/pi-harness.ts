// Minimal host contract for the Pi extensions under pi/extensions: the factory
// receives an ExtensionAPI, and every hook receives an ExtensionContext. Those
// two surfaces are all the extensions touch, so a fake of exactly that surface
// exercises the real source without a running Pi.

export type RecordedRequest = { url: string; path: string; body: any };

function stubFetch(respond?: (path: string, body: any) => unknown) {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, path, body });
    const value = respond?.(path, body);
    return new Response(JSON.stringify(value ?? {}), { status: 200 });
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export function piHarness(respond?: (path: string, body: any) => unknown) {
  const fetch = stubFetch(respond);
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const busHandlers = new Map<string, Array<(data: any) => void>>();
  const entries: Array<{ customType: string; data: any }> = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
  const skills: Array<{ name: string; path: string }> = [];

  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    events: {
      on(name: string, handler: (data: any) => void) {
        const list = busHandlers.get(name) ?? [];
        list.push(handler);
        busHandlers.set(name, list);
        return () => {};
      },
    },
    appendEntry(customType: string, data?: any) {
      entries.push({ customType, data });
    },
    registerCommand(
      name: string,
      definition: { description?: string; handler: (args: string, ctx: any) => Promise<void> },
    ) {
      commands.set(name, definition);
    },
    getSettings: () => ({ theme: "dark" }),
    getMcpServers: () => [{ name: "agentmemory" }, { name: "context7" }],
    // Pi exposes discovered skills as "/skill:<name>" commands carrying the file
    // path the model reads; the extensions map a read back to a skill this way.
    getCommands: () =>
      skills.map((skill) => ({
        name: `skill:${skill.name}`,
        source: "skill",
        sourceInfo: { path: skill.path },
      })),
  };

  function ctx(id: string, overrides: Record<string, unknown> = {}) {
    return {
      cwd: process.cwd(),
      model: { provider: "anthropic", id: "claude-sonnet" },
      modelRegistry: { getAll: () => [{ provider: "anthropic" }, { provider: "openai" }] },
      thinkingLevel: "high",
      hasUI: true,
      ui: { notify: (message: string, level?: string) => notifications.push({ message, level }) },
      sessionManager: {
        getSessionId: () => id,
        getHeader: () => ({ version: 3 }),
        getSessionName: () => "test session",
      },
      ...overrides,
    };
  }

  // Hooks chain: a handler returning `messages` replaces what the next handler
  // sees, exactly like Pi's ExtensionRunner.
  async function emit(name: string, event: any, context: any) {
    let current = event;
    let last: any;
    for (const handler of handlers.get(name) ?? []) {
      last = await handler(current, context);
      if (last && Array.isArray(last.messages)) current = { ...current, messages: last.messages };
    }
    return last;
  }

  function emitBus(name: string, data: any) {
    for (const handler of busHandlers.get(name) ?? []) handler(data);
  }

  // Bus handlers cannot await: the capture extension dispatches its POST with
  // `void`, so a test must let the fetch promise chain settle before asserting.
  async function drain(ticks = 8) {
    for (let index = 0; index < ticks; index += 1) await Promise.resolve();
  }

  return {
    pi,
    skills,
    entries,
    notifications,
    commands,
    requests: fetch.requests,
    ctx,
    emit,
    emitBus,
    drain,
    restore: fetch.restore,
  };
}
