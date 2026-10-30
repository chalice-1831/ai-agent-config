import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// Port of the local OpenCode agentmemory-capture, not the upstream default plugin.
const API = process.env.AGENTMEMORY_URL || "http://localhost:3111";
const DEBUG = process.env.OPENCODE_AGENTMEMORY_DEBUG === "1";
const FILE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "find"]);
const FILE_KEYS = ["filePath", "file_path", "path", "file", "pattern"];
const MAX_STASHED_FILES = 20;
const SESSION_END_COMMAND = "session-end";

function usableSecret(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || (trimmed.startsWith("${") && trimmed.endsWith("}"))) return "";
  return trimmed;
}

function readAgentmemoryFile(name: string): string {
  try {
    return readFileSync(join(homedir(), ".agentmemory", name), "utf-8");
  } catch {
    return "";
  }
}

function envFileSecret(): string {
  let found = "";
  for (const line of readAgentmemoryFile(".env").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).replace(/^export\s+/, "").trim() !== "AGENTMEMORY_SECRET") continue;
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    const close = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    if (close > 0) value = value.slice(1, close);
    else if (value.includes(" #")) value = value.slice(0, value.indexOf(" #"));
    found = usableSecret(value);
  }
  return found;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function resolveSecret(url: string, explicit: string | undefined): string {
  const configured = usableSecret(explicit);
  if (configured) return configured;
  if (!isLoopbackUrl(url)) return "";
  return envFileSecret() || usableSecret(readAgentmemoryFile("secret"));
}

const SECRET = resolveSecret(API, process.env.AGENTMEMORY_SECRET);

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) headers["Authorization"] = `Bearer ${SECRET}`;
  return headers;
}

async function post(path: string, body: Record<string, unknown>, timeoutMs = 5000): Promise<void> {
  try {
    await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
  }
}

async function postJson(path: string, body: Record<string, unknown>): Promise<unknown | null> {
  try {
    const res = await fetch(`${API}/agentmemory${path}`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? await res.json() : null;
  } catch (e) {
    if (DEBUG) console.error(`[agentmemory] POST ${path} failed:`, (e as Error).message);
    return null;
  }
}

function safeSlice(v: unknown, max: number): string {
  if (typeof v === "string") return v.slice(0, max);
  if (v == null) return "";
  try {
    return JSON.stringify(v).slice(0, max);
  } catch {
    return "";
  }
}

function contextText(result: unknown): string {
  if (!result || typeof result !== "object" || !("context" in result)) return "";
  return typeof result.context === "string" ? result.context : "";
}

function hasEmptyMemorySearchResult(toolName: string, output: unknown, details?: Record<string, unknown>): boolean {
  // Adapter namespace and generic proxies identify the resolved target in details.
  // Direct tools retain their qualified name; do not infer a server from a bare tool.
  const name = (toolName === "mcp__agentmemory" || toolName === "mcp")
    && details?.server === "agentmemory" && typeof details.tool === "string"
    ? `agentmemory_${details.tool}`
    : toolName.replace(/^mcp__agentmemory__/, "agentmemory_");
  if (details?.error) return false;
  const raw = details?.mcpResult;
  if (raw && typeof raw === "object" && !("omitted" in raw)) {
    const result = raw as Record<string, unknown>;
    if (result.isError) return false;
    output = result.structuredContent ?? (Array.isArray(result.content)
      ? result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : output);
  }
  const searchTools = ["recall", "search", "patterns", "sessions", "history"];
  if (!name.startsWith("agentmemory_memory_") || !searchTools.some((part) => name.includes(part))) return false;
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Array.isArray(result.results) && result.results.length === 0;
}

type PermissionPrompt = {
  sessionId: string;
  surface: string | null;
  value: string | null;
  title: string;
};

// A decision with no prompt is normally the config settling the ask, which
// happens for nearly every tool call; recording those would drown the memory
// feed. Only an anomaly where nobody was asked is worth an observation.
const UNPROMPTED_ANOMALIES = new Set([
  "gate_error",
  "confirmation_unavailable",
  "authorizer_denied",
]);

const AGENTMEMORY_INSTRUCTIONS = `<agentmemory-instructions>
You have access to agentmemory for persistent cross-session memory. Use these tools proactively.

CORE TOOLS:

memory_save — Save an insight, decision, or fact to long-term memory.
  Required: content (text), concepts (2-5 comma-separated keywords), type (pattern/preference/architecture/bug/workflow/fact)
  Optional: files (comma-separated paths)
  Use when: user says "remember this", after discovering a bug, after making an architectural decision, after learning a project convention.

memory_recall — Search past observations by keywords.
  Use when: user says "recall", "what did we do", "do you remember", or needs context from past sessions.

memory_smart_search — Hybrid semantic+keyword search with progressive disclosure.
  Use when: you need the most relevant past context, fuzzy/conceptual searches, or recall doesn't find what you need.

memory_sessions — List recent sessions with status and observation counts.
  Use when: user asks about session/past history, "what did we work on".

memory_file_history — Get past observations about specific files (across all sessions).
  Use when: you're about to edit a file and want to know its history, common pitfalls, or past edits.

memory_lesson_save — Save a lesson learned (what worked, what to avoid).
  Use when: you discover a pattern that could help future sessions avoid mistakes.

memory_lesson_recall — Search lessons by query. Returns lessons sorted by confidence.
  Use when: before making a decision, check if past lessons apply.

memory_governance_delete — Delete specific memories. Requires explicit user confirmation.
  Use when: user says "forget this", "delete that memory".

memory_patterns — Detect recurring patterns across sessions.
  Use when: you want to understand project-level trends over time.

memory_consolidate — Run the 4-tier memory consolidation pipeline.
  Use when: you want to compress and organize accumulated session observations.

Memory tools belong to the agentmemory namespace (Pi MCP names start with \`mcp__agentmemory__memory_\`). Use the exact names as they appear in your tool list. Tool results are JSON. Always check what was returned before presenting to the user.
</agentmemory-instructions>`;

export default function AgentmemoryCapturePlugin(pi: ExtensionAPI) {
  // Factory-local state is isolated across Pi runtime replacements and reloads.
  const endedSessions = new Set<string>();
  const sessionProjects = new Map<string, { name: string; cwd: string }>();
  const projectNameCache = new Map<string, string>();
  const stashedFiles = new Map<string, Set<string>>();
  const seenToolCallIds = new Map<string, Set<string>>();
  // Keyed by tool call id, so the owning session travels with the input: ending
  // one session must not drop another session's pending call inputs.
  const toolInputs = new Map<string, { sessionId: string; input: Record<string, unknown> }>();
  const contextInjectedSessions = new Set<string>();
  const startContextCache = new Map<string, string>();
  // Permission prompts shown to the user, keyed by request id, so a decision
  // can be matched back to the prompt it answered even when it resolves after
  // the active session changed. Pi's permission events carry no session id, so
  // each prompt stores the session that was active when the UI showed it.
  const promptedPermissions = new Map<string, PermissionPrompt>();
  let permissionSessionId = "";

  function resolveProjectName(dir: string): string {
    const explicit = process.env.AGENTMEMORY_PROJECT_NAME?.trim();
    if (explicit) return explicit;
    const cached = projectNameCache.get(dir);
    if (cached !== undefined) return cached;
    let name = basename(dir) || dir;
    try {
      const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
      if (top) name = basename(top);
    } catch {
      // Not a git repo: preserve the original cwd-basename fallback.
    }
    projectNameCache.set(dir, name);
    return name;
  }

  function projectFor(ctx: ExtensionContext) {
    const sid = ctx.sessionManager.getSessionId();
    let project = sessionProjects.get(sid);
    if (!project) {
      const cwd = ctx.cwd;
      project = { name: resolveProjectName(cwd), cwd };
      sessionProjects.set(sid, project);
    }
    return project;
  }

  async function observe(ctx: ExtensionContext, hookType: string, data: Record<string, unknown>): Promise<void> {
    const sessionId = ctx.sessionManager.getSessionId();
    if (endedSessions.has(sessionId)) return;
    const project = projectFor(ctx);
    await post("/observe", {
      hookType,
      sessionId,
      project: project.name,
      cwd: project.cwd,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  // Extension-bus events carry no ExtensionContext. They still belong to the
  // session_start-registered project, so they reuse the same payload shape.
  async function observeSession(sessionId: string, hookType: string, data: Record<string, unknown>): Promise<void> {
    const project = sessionProjects.get(sessionId);
    if (!project || endedSessions.has(sessionId)) return;
    await post("/observe", {
      hookType,
      sessionId,
      project: project.name,
      cwd: project.cwd,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  function stashFor(sid: string): Set<string> {
    let stash = stashedFiles.get(sid);
    if (!stash) {
      stash = new Set();
      stashedFiles.set(sid, stash);
    }
    return stash;
  }

  function stashPaths(sid: string, input: Record<string, unknown>): void {
    const stash = stashFor(sid);
    for (const key of FILE_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.length > 0) stash.add(value);
    }
    if (stash.size > MAX_STASHED_FILES) {
      const keep = [...stash].slice(-MAX_STASHED_FILES);
      stash.clear();
      for (const file of keep) stash.add(file);
    }
  }

  function pruneSession(sid: string): void {
    stashedFiles.delete(sid);
    seenToolCallIds.delete(sid);
    sessionProjects.delete(sid);
    startContextCache.delete(sid);
    contextInjectedSessions.delete(sid);
    for (const [requestId, prompt] of promptedPermissions) {
      if (prompt.sessionId === sid) promptedPermissions.delete(requestId);
    }
    for (const [toolCallId, pending] of toolInputs) {
      if (pending.sessionId === sid) toolInputs.delete(toolCallId);
    }
  }

  async function endSession(sid: string): Promise<void> {
    if (endedSessions.has(sid)) return;
    endedSessions.add(sid);
    await post("/session/end", { sessionId: sid });
    void post("/crystals/auto", { olderThanDays: 7 }, 30000);
    void post("/consolidate-pipeline", { tier: "all", force: true }, 30000);
    pruneSession(sid);
  }

  // Pi's permission-system extension broadcasts on the shared event bus
  // (`permissions:*` in docs/cross-extension-api.md). Those broadcasts are the
  // only Pi surface that reports a prompt and its resolution, so they back the
  // OpenCode `permission.asked` / `permission.replied` observations.
  pi.events.on("permissions:ready", (data) => {
    const sessionId = (data as { sessionId?: unknown } | null)?.sessionId;
    // A subagent node announces its own child session on the same bus; only a
    // session this extension captured at session_start owns observations, so a
    // child announcement must not steal attribution from its parent.
    if (typeof sessionId === "string" && sessionProjects.has(sessionId)) permissionSessionId = sessionId;
  });

  pi.events.on("permissions:ui_prompt", (data) => {
    const prompt = (data ?? {}) as {
      requestId?: unknown;
      surface?: unknown;
      value?: unknown;
      request?: { surface?: unknown; value?: unknown };
    };
    const requestId = typeof prompt.requestId === "string" ? prompt.requestId : "";
    const sid = permissionSessionId;
    if (!requestId || !sid) return;
    const surface = typeof prompt.surface === "string" && prompt.surface
      ? prompt.surface
      : typeof prompt.request?.surface === "string" ? prompt.request.surface : null;
    const value = typeof prompt.value === "string" && prompt.value
      ? prompt.value
      : typeof prompt.request?.value === "string" ? prompt.request.value : null;
    const title = surface && value ? `${surface}: ${value}` : surface ?? value ?? "permission";
    promptedPermissions.set(requestId, {
      sessionId: sid,
      surface,
      value,
      title,
    });
    void observeSession(sid, "notification", {
      notification_type: "permission_prompt",
      permission: surface ?? "unknown",
      pattern: value ?? "",
      patterns: value ? [value] : [],
      tool_call_id: null,
      title,
    });
  });

  pi.events.on("permissions:decision", (data) => {
    const decision = (data ?? {}) as {
      requestId?: unknown;
      surface?: unknown;
      value?: unknown;
      result?: unknown;
      resolution?: unknown;
      origin?: unknown;
      matchedPattern?: unknown;
    };
    const requestId = typeof decision.requestId === "string" ? decision.requestId : "";
    if (!requestId) return;
    const prompt = promptedPermissions.get(requestId);
    promptedPermissions.delete(requestId);
    // A prompt that was shown is always answered on the record, against the
    // session that owns it. Without one, only an unattributed failure is worth
    // storing: policy allow/deny covers nearly every ordinary tool call.
    if (!prompt && !UNPROMPTED_ANOMALIES.has(typeof decision.resolution === "string" ? decision.resolution : "")) return;
    const sid = prompt?.sessionId ?? permissionSessionId;
    if (!sid) return;
    const resolution = typeof decision.resolution === "string" ? decision.resolution : null;
    const surface = typeof decision.surface === "string" ? decision.surface : prompt?.surface ?? "unknown";
    const value = typeof decision.value === "string" ? decision.value : prompt?.value ?? "";
    const title = prompt?.title ?? (value ? `${surface}: ${value}` : surface);
    void observeSession(sid, "permission_replied", {
      permission_id: requestId,
      response: typeof decision.result === "string" ? decision.result : "",
      permission: surface,
      pattern: value,
      patterns: value ? [value] : [],
      tool_call_id: null,
      title,
      resolution,
      origin: typeof decision.origin === "string" ? decision.origin : null,
      matched_pattern: typeof decision.matchedPattern === "string" ? decision.matchedPattern : null,
    });
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    permissionSessionId = sessionId;
    const project = projectFor(ctx);
    const header = ctx.sessionManager.getHeader();
    const result = await postJson("/session/start", {
      sessionId,
      title: ctx.sessionManager.getSessionName() ?? null,
      // Pi exposes a parent session file, not an OpenCode parent session ID.
      parentID: null,
      version: header?.version ?? null,
      project: project.name,
      cwd: project.cwd,
    });
    const context = contextText(result);
    if (context) startContextCache.set(sessionId, context);
    const settings = pi.getSettings();
    await observe(ctx, "config_loaded", {
      theme: settings.theme ?? null,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      autoupdate: null,
      agents: [],
      mcp_servers: pi.getMcpServers().map((server) => server.name),
      providers: [...new Set(ctx.modelRegistry.getAll().map((model) => model.provider))],
      permission: null,
    });
  });

  // A process exit/reload/switch is not session deletion. Only explicit session-end
  // ends memory and runs consolidation, matching the local OpenCode policy.
  pi.on("session_shutdown", (_event, ctx) => {
    pruneSession(ctx.sessionManager.getSessionId());
  });
  pi.registerCommand(SESSION_END_COMMAND, {
    description: "End agentmemory capture for this session and consolidate memory",
    handler: async (_args, ctx) => {
      await endSession(ctx.sessionManager.getSessionId());
      if (ctx.hasUI) ctx.ui.notify("Session ended. Start a new session before continuing.", "info");
    },
  });

  // Admission-time input includes steering/follow-up prompts, not only new runs.
  pi.on("input", async (event, ctx) => {
    await observe(ctx, "prompt_submit", {
      agent: null,
      model: ctx.model ? { providerID: ctx.model.provider, modelID: ctx.model.id } : null,
      variant: ctx.thinkingLevel ?? null,
      prompt: event.text.slice(0, 8000),
      // Pi images contain bytes/mimeType, not source paths. Never log image bytes.
      files: [],
      parts_summary: ["text", ...(event.images ?? []).map(() => "file")],
    });
  });

  pi.on("tool_call", (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (endedSessions.has(sid)) return;
    toolInputs.set(event.toolCallId, { sessionId: sid, input: event.input });
    if (FILE_TOOLS.has(event.toolName.toLowerCase())) {
      stashPaths(sid, event.input);
    }
  });

  // Execution-end includes duration, final results and nested codemode calls.
  // Observing tool_result as well would double-count successful calls.
  pi.on("tool_execution_end", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const input = toolInputs.get(event.toolCallId)?.input;
    toolInputs.delete(event.toolCallId);
    if (endedSessions.has(sid)) return;
    let seen = seenToolCallIds.get(sid);
    if (!seen) {
      seen = new Set();
      seenToolCallIds.set(sid, seen);
    }
    if (seen.has(event.toolCallId)) return;
    seen.add(event.toolCallId);
    const result = event.result;
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content.filter((part: { type: string }) => part.type === "text")
      .map((part: { text: string }) => part.text).join("\n");
    const output = result?.structuredContent ?? text;
    if (!event.isError && hasEmptyMemorySearchResult(event.toolName, output, result?.details)) return;
    await observe(ctx, event.isError ? "post_tool_failure" : "post_tool_use", {
      tool_name: event.toolName,
      call_id: event.toolCallId,
      tool_input: safeSlice(input, 4000),
      tool_output: safeSlice(output, 8000),
      duration_ms: event.durationMs ?? null,
      ...(!event.isError ? {
        title: null,
        metadata: result?.details ?? {},
        attachments: [],
      } : {}),
    });
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    // Record finalized reasoning once, not every streaming delta.
    for (const part of message.content) {
      if (part.type !== "thinking") continue;
      const text = safeSlice(part.thinking, 4000).trim();
      if (text) await observe(ctx, "reasoning", { messageID: null, text });
    }
    if (!message.errorMessage) return;
    await observe(ctx, "assistant_message", {
      messageID: null,
      parentID: null,
      modelID: message.model,
      providerID: message.provider,
      mode: null,
      cost: message.usage.cost.total,
      tokens: {
        input: message.usage.input,
        output: message.usage.output,
        reasoning: 0,
        cache_read: message.usage.cacheRead,
        cache_write: message.usage.cacheWrite,
      },
      finish: message.stopReason,
      error: message.errorMessage,
      duration_ms: null,
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (!endedSessions.has(sid)) await post("/summarize", { sessionId: sid });
  });
  pi.on("session_compact", async (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (!endedSessions.has(sid)) await post("/summarize", { sessionId: sid });
  });

  pi.on("context_with_system", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const [system, ...rest] = event.messages;
    if (endedSessions.has(sid) || system?.role !== "system") return;
    const extra: string[] = [];
    if (!contextInjectedSessions.has(sid)) {
      extra.push(AGENTMEMORY_INSTRUCTIONS);
      let context = startContextCache.get(sid);
      if (!context) {
        context = contextText(await postJson("/context", {
          sessionId: sid,
          project: projectFor(ctx).name,
        }));
      } else {
        startContextCache.delete(sid);
      }
      if (context) extra.push(context);
      contextInjectedSessions.add(sid);
    }
    const stash = stashFor(sid);
    const files = [...stash].slice(0, 10);
    if (files.length > 0) {
      const enrichment = contextText(await postJson("/enrich", {
        sessionId: sid,
        files,
        toolName: "enrich_inject",
      }));
      if (enrichment) {
        extra.push(enrichment);
        for (const file of files) stash.delete(file);
      }
    }
    if (extra.length === 0) return;
    const content = typeof system.content === "string"
      ? `${system.content}\n\n${extra.join("\n\n")}`
      : [...system.content, ...extra.map((text) => ({ type: "text" as const, text }))];
    // Preserve Pi's sections and tool declarations; transform only this request.
    return { messages: [{ ...system, content }, ...rest] };
  });

  // Pi 1.3.0 has no equivalent events for session.diff/deleted/status/error,
  // message.removed, todo.updated, subtask/patch/retry parts, file attachments
  // with source paths, or generic command.executed. Permission prompts are
  // observed above through the shared bus, but the audit log the OpenCode
  // permission-audit plugin writes is already produced by pi-permission-system
  // (`permissionReviewLog`, on by default). Pi's before-compaction hook can
  // cancel/replace compaction but cannot append to its system prompt. Do not
  // replace Pi's compactor to fake that hook.
}
