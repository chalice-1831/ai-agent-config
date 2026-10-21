import { Plugin } from "@opencode/plugin";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

function projectRoot(directory: string): string {
  try {
    return (
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: directory,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim() || directory
    );
  } catch {
    return directory;
  }
}

function locationDirectory(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["path", "directory", "cwd"]) {
    if (typeof record[key] === "string" && record[key])
      return record[key] as string;
  }
  return "";
}

export const PermissionAuditPlugin = Plugin.define({
  id: "permission-audit",
  async setup(ctx) {
    const client = (ctx as any).client ?? ctx;
    const worktree =
      locationDirectory((ctx as any).worktree) ||
      locationDirectory((ctx as any).location?.directory);
    const directory =
      locationDirectory((ctx as any).directory) ||
      locationDirectory((ctx as any).location?.directory);
    const logDirectory = join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "opencode",
      "permission-audit",
    );
    const defaultRoot = projectRoot(worktree || directory);
    const sessionRoots = new Map<string, string>();
    let lastWarning = "";

    async function reportFailure(error: unknown): Promise<void> {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "unknown";
      const message = `Cannot write permission audit log (${code}); permission request was not recorded`;
      try {
        const result = await client.app.log({
          body: { service: "permission-audit", level: "error", message },
        });
        if (result.error) console.error(`[permission-audit] ${message}`);
      } catch {
        console.error(`[permission-audit] ${message}`);
      }
      if (lastWarning === code) return;
      lastWarning = code;
      try {
        await client.tui.showToast({
          body: { title: "Permission audit", message, variant: "error" },
        });
      } catch {}
    }

    async function record(entry: Record<string, unknown>): Promise<void> {
      const timestamp = new Date().toISOString();
      const filename = join(logDirectory, `${timestamp.slice(0, 13)}.jsonl`);
      try {
        await mkdir(logDirectory, { recursive: true, mode: 0o700 });
        const directoryInfo = await lstat(logDirectory);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
          throw new Error("invalid audit directory");
        await chmod(logDirectory, 0o700);
        const file = await open(
          filename,
          constants.O_APPEND |
            constants.O_CREAT |
            constants.O_WRONLY |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.chmod(0o600);
          const line = JSON.stringify({ timestamp, ...entry }) + "\n";
          const { bytesWritten } = await file.write(line);
          if (bytesWritten !== Buffer.byteLength(line))
            throw new Error("short write");
        } finally {
          await file.close();
        }
        lastWarning = "";
      } catch (error) {
        await reportFailure(error);
      }
    }

    const controller = new AbortController();
    void (async () => {
      for await (const event of client.event.subscribe({
        signal: controller.signal,
      })) {
        const record = (event ?? {}) as {
          type?: string;
          properties?: Record<string, unknown>;
        };
        const type = record.type;
        const properties = record.properties ?? {};
        if (type === "session.created") {
          const info = properties.info as
            { id?: string; directory?: string } | undefined;
          if (info?.id && info.directory)
            sessionRoots.set(info.id, projectRoot(info.directory));
          continue;
        }
        if (type === "session.deleted") {
          const info = properties.info as { id?: string } | undefined;
          if (info?.id) sessionRoots.delete(info.id);
          continue;
        }
        if (type !== "permission.asked" && type !== "permission.replied")
          continue;

        const sessionID = properties.sessionID;
        const root =
          typeof sessionID === "string"
            ? sessionRoots.get(sessionID) || defaultRoot
            : defaultRoot;
        if (type === "permission.asked") {
          if (
            typeof properties.id !== "string" ||
            typeof properties.permission !== "string" ||
            !Array.isArray(properties.patterns) ||
            !properties.patterns.every((pattern) => typeof pattern === "string")
          )
            continue;
          await record({
            event: "request",
            requestId: properties.id,
            projectRoot: root,
            permission: properties.permission,
            patterns: properties.patterns,
          });
          continue;
        }
        if (
          typeof properties.requestID !== "string" ||
          typeof properties.reply !== "string"
        )
          continue;
        await record({
          event: "reply",
          requestId: properties.requestID,
          projectRoot: root,
          reply: properties.reply,
        });
      }
    })();

    return () => controller.abort();
  },
});

export default PermissionAuditPlugin;
