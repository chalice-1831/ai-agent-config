import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionAuditPlugin } from "../opencode/plugins/permission-audit";

let temporaryDirectory: string;
let previousStateHome: string | undefined;

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "permission-audit-"));
  previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = temporaryDirectory;
});

afterEach(async () => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("records only permission prompts and replies in private hourly JSONL", async () => {
  const project = join(temporaryDirectory, "project");
  const nestedDirectory = join(project, "nested");
  await mkdir(nestedDirectory, { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  const client = {
    app: { log: async () => ({}) },
    tui: { showToast: async () => ({}) },
  };
  const plugin = await PermissionAuditPlugin({ client, worktree: project, directory: project } as any);
  const send = async (type: string, properties: Record<string, unknown>) => {
    await plugin.event?.({ event: { type, properties } as any });
  };

  await send("session.created", { info: { id: "session-1", directory: nestedDirectory } });
  await send("permission.asked", {
    id: "per-1", sessionID: "session-1", permission: "bash",
    patterns: ["git status", "git show *"], metadata: { token: "private" },
  });
  await send("permission.replied", { requestID: "per-1", sessionID: "session-1", reply: "once" });
  await send("tool.execute.after", { sessionID: "session-1", metadata: { token: "private" } });

  const logDirectory = join(temporaryDirectory, "opencode", "permission-audit");
  const files = await readdir(logDirectory);
  expect(files).toHaveLength(1);
  expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(logDirectory, files[0]))).mode & 0o777).toBe(0o600);
  const contents = await readFile(join(logDirectory, files[0]), "utf8");
  expect(contents).not.toContain("private");
  const records = contents.trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(files[0]).toBe(`${records[0].timestamp.slice(0, 13)}.jsonl`);
  expect(records[0]).toEqual({
    timestamp: expect.any(String), event: "request", requestId: "per-1", projectRoot: project,
    permission: "bash", patterns: ["git status", "git show *"],
  });
  expect(records[1]).toEqual({
    timestamp: expect.any(String), event: "reply", requestId: "per-1", projectRoot: project,
    reply: "once",
  });
});

test("rotates JSONL files by event hour without discarding earlier records", async () => {
  const client = { app: { log: async () => ({}) }, tui: { showToast: async () => ({}) } };
  const plugin = await PermissionAuditPlugin({ client, worktree: temporaryDirectory, directory: temporaryDirectory } as any);
  try {
    setSystemTime(new Date("2026-01-01T04:59:59Z"));
    await plugin.event?.({ event: { type: "permission.asked", properties: {
      id: "per-3", sessionID: "session-3", permission: "bash", patterns: ["git status"],
    } } as any });
    setSystemTime(new Date("2026-01-01T05:00:00Z"));
    await plugin.event?.({ event: { type: "permission.replied", properties: {
      requestID: "per-3", sessionID: "session-3", reply: "always",
    } } as any });
  } finally {
    setSystemTime();
  }

  const files = await readdir(join(temporaryDirectory, "opencode", "permission-audit"));
  expect(files.sort()).toEqual(["2026-01-01T04.jsonl", "2026-01-01T05.jsonl"]);
});

test("reports repeated write failures without blocking permission replies", async () => {
  const blockedPath = join(temporaryDirectory, "not-a-directory");
  await writeFile(blockedPath, "occupied");
  process.env.XDG_STATE_HOME = blockedPath;
  const errors: string[] = [];
  const notifications: string[] = [];
  const client = {
    app: { log: async ({ body }: { body: { message: string } }) => {
      errors.push(body.message);
      return {};
    } },
    tui: { showToast: async ({ body }: { body: { message: string } }) => {
      notifications.push(body.message);
      return {};
    } },
  };
  const plugin = await PermissionAuditPlugin({ client, worktree: temporaryDirectory, directory: temporaryDirectory } as any);

  await plugin.event?.({ event: { type: "permission.asked", properties: {
    id: "per-2", sessionID: "session-2", permission: "bash", patterns: ["secret-command"],
  } } as any });
  await plugin.event?.({ event: { type: "permission.replied", properties: {
    requestID: "per-2", sessionID: "session-2", reply: "reject",
  } } as any });

  expect(errors).toHaveLength(2);
  expect(notifications).toHaveLength(1);
  expect(errors[0]).toContain("Cannot write permission audit log");
  expect(errors.join(" ") + notifications.join(" ")).not.toContain("secret-command");
});

test("rejects a symlinked audit directory without blocking the request", async () => {
  const target = join(temporaryDirectory, "outside");
  await mkdir(target);
  const pluginDirectory = join(temporaryDirectory, "opencode");
  await mkdir(pluginDirectory);
  await symlink(target, join(pluginDirectory, "permission-audit"));
  const errors: string[] = [];
  const client = {
    app: { log: async ({ body }: { body: { message: string } }) => {
      errors.push(body.message);
      return {};
    } },
    tui: { showToast: async () => ({}) },
  };
  const plugin = await PermissionAuditPlugin({ client, worktree: temporaryDirectory, directory: temporaryDirectory } as any);
  await plugin.event?.({ event: { type: "permission.asked", properties: {
    id: "per-4", sessionID: "session-4", permission: "bash", patterns: ["git status"],
  } } as any });

  expect(errors).toHaveLength(1);
  expect(await readdir(target)).toEqual([]);
});
