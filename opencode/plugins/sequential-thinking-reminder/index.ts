import { Plugin } from "@opencode/plugin";
import { SequentialThinkingReminderRpc } from "./rpc";

const THOUGHT_REMINDER_INTERVAL = 2;
const SEQUENTIAL_THINKING_TOOL_ID = "sequential-thinking_sequentialthinking";
const ACTIVE_MESSAGE =
  "Monitoring reasoning thoughts and sequential-thinking usage.";

type RecordValue = Record<string, unknown>;

type ReasoningPart = {
  messageID: string;
  text: string;
  completed: boolean;
  counted: boolean;
};

type SessionState = {
  activeEmitted: boolean;
  reasoningParts: Map<string, ReasoningPart>;
  unpairedThoughts: number;
  reminderLevel: number;
  nextReminderAt: number;
};

function asRecord(value: unknown): RecordValue {
  return value && typeof value === "object" ? (value as RecordValue) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function eventProperties(event: unknown): RecordValue {
  return asRecord(asRecord(event).properties);
}

function eventSessionID(event: unknown): string {
  const properties = eventProperties(event);
  const info = asRecord(properties.info);
  return (
    stringValue(properties.sessionID) ||
    stringValue(info.sessionID) ||
    stringValue(asRecord(properties.part).sessionID)
  );
}

function sessionIDFromTool(event: unknown): string {
  const value = asRecord(event).sessionID;
  return stringValue(value);
}

function partIsComplete(part: RecordValue): boolean {
  if (part.completed === true) return true;
  const time = asRecord(part.time);
  return time.completed != null || time.end != null;
}

function messageIsFinished(info: RecordValue): boolean {
  return info.role === "assistant" && info.finish != null;
}

function getPartID(part: RecordValue): string {
  return stringValue(part.id) || stringValue(part.partID);
}

function getMessageID(part: RecordValue): string {
  return stringValue(part.messageID) || stringValue(part.messageId);
}

function getState(
  states: Map<string, SessionState>,
  sessionID: string,
): SessionState {
  let state = states.get(sessionID);
  if (!state) {
    state = {
      activeEmitted: false,
      reasoningParts: new Map(),
      unpairedThoughts: 0,
      reminderLevel: 0,
      nextReminderAt: THOUGHT_REMINDER_INTERVAL,
    };
    states.set(sessionID, state);
  }
  return state;
}

export const SequentialThinkingReminderPlugin = Plugin.define({
  id: "sequential-thinking-reminder",
  async setup(ctx) {
    const client = (ctx as any).client ?? ctx;
    const states = new Map<string, SessionState>();
    const reminders = await ctx.rpc.register(SequentialThinkingReminderRpc, {});

    async function logEvent(
      level: "debug" | "info" | "error",
      message: string,
      fields: Record<string, unknown> = {},
    ): Promise<void> {
      try {
        await client.app.log({
          body: {
            service: "sequential-thinking-reminder",
            level,
            message,
            ...fields,
          },
        });
      } catch {
        // Observability failures must not affect the reminder behavior.
      }
    }

    async function emit(
      event: "active" | "reminder",
      data: Record<string, unknown>,
    ): Promise<void> {
      try {
        await reminders.events.emit(event, data);
      } catch (error) {
        console.error(
          `[sequential-thinking-reminder] Failed to emit ${event}`,
          error,
        );
        void logEvent("error", `Failed to emit ${event}`);
      }
    }

    async function ensureActive(sessionID: string): Promise<SessionState> {
      const state = getState(states, sessionID);
      if (!state.activeEmitted) {
        state.activeEmitted = true;
        await emit("active", { sessionID, message: ACTIVE_MESSAGE });
        void logEvent("debug", "Sequential-thinking guard active", {
          sessionID,
          trigger: "active",
        });
      }
      return state;
    }

    function countReasoningPart(state: SessionState, partID: string): void {
      const part = state.reasoningParts.get(partID);
      if (!part || part.counted || !part.text.trim()) return;
      part.counted = true;
      state.unpairedThoughts += 1;
    }

    function updateReasoningPart(sessionID: string, part: RecordValue): void {
      const partID = getPartID(part);
      const messageID = getMessageID(part);
      const text = stringValue(part.text);
      if (!partID || !messageID || part.type !== "reasoning") return;

      const state = getState(states, sessionID);
      const existing = state.reasoningParts.get(partID);
      const reasoningPart: ReasoningPart = existing ?? {
        messageID,
        text: "",
        completed: false,
        counted: false,
      };
      reasoningPart.text = text || reasoningPart.text;
      reasoningPart.completed = reasoningPart.completed || partIsComplete(part);
      state.reasoningParts.set(partID, reasoningPart);
      if (reasoningPart.completed) countReasoningPart(state, partID);
    }

    function finalizeMessage(sessionID: string, messageID: string): void {
      if (!messageID) return;
      const state = getState(states, sessionID);
      for (const [partID, part] of state.reasoningParts) {
        if (part.messageID !== messageID) continue;
        part.completed = true;
        countReasoningPart(state, partID);
      }
    }

    function resetAfterSuccessfulThinking(sessionID: string): void {
      const state = getState(states, sessionID);
      state.unpairedThoughts = 0;
      state.reminderLevel = 0;
      state.nextReminderAt = THOUGHT_REMINDER_INTERVAL;
    }

    function isTargetTool(tool: unknown): boolean {
      return tool === SEQUENTIAL_THINKING_TOOL_ID;
    }

    function reminderMessage(thoughtCount: number): string {
      return `The agent has completed ${thoughtCount} reasoning thoughts without using the sequential-thinking tool. Use sequential-thinking before continuing.`;
    }

    async function injectReminder(
      sessionID: string,
      event: any,
    ): Promise<void> {
      if (!Array.isArray(event.system)) return;
      const state = await ensureActive(sessionID);
      if (state.unpairedThoughts < state.nextReminderAt) return;

      state.reminderLevel += 1;
      state.nextReminderAt = state.unpairedThoughts + THOUGHT_REMINDER_INTERVAL;
      const message = reminderMessage(state.unpairedThoughts);
      event.system.push({
        type: "text",
        text: `[Sequential-thinking reminder]\n${message}`,
      });
      await emit("reminder", {
        sessionID,
        message,
        thoughtCount: state.unpairedThoughts,
        level: state.reminderLevel,
      });
      void logEvent("info", "Sequential-thinking reminder emitted", {
        sessionID,
        trigger: "reminder",
        thoughtCount: state.unpairedThoughts,
        reminderLevel: state.reminderLevel,
      });
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of client.event.subscribe({
          signal: controller.signal,
        })) {
          const record = asRecord(event);
          const type = stringValue(record.type);
          const properties = eventProperties(event);

          if (type === "session.created") {
            const info = asRecord(properties.info);
            const sessionID =
              stringValue(info.id) || stringValue(properties.sessionID);
            if (sessionID) getState(states, sessionID);
            continue;
          }

          if (type === "session.deleted") {
            const info = asRecord(properties.info);
            const sessionID =
              stringValue(info.id) || stringValue(properties.sessionID);
            if (sessionID) states.delete(sessionID);
            continue;
          }

          if (type === "message.part.updated") {
            const part = asRecord(properties.part);
            const sessionID = eventSessionID(event);
            if (!sessionID) continue;
            await ensureActive(sessionID);
            updateReasoningPart(sessionID, part);
            continue;
          }

          if (type === "message.updated") {
            const info = asRecord(properties.info);
            const sessionID = eventSessionID(event);
            if (!sessionID) continue;
            await ensureActive(sessionID);
            if (messageIsFinished(info)) {
              finalizeMessage(sessionID, stringValue(info.id));
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error(
            "[sequential-thinking-reminder] Event subscription failed",
            error,
          );
          void logEvent("error", "Event subscription failed");
        }
      }
    })();

    await client.tool.hook("execute.after", async (event: any) => {
      if (!isTargetTool(event.tool) || event.status !== "completed") return;
      const sessionID = sessionIDFromTool(event);
      if (!sessionID) return;
      await ensureActive(sessionID);
      resetAfterSuccessfulThinking(sessionID);
      void logEvent("debug", "Sequential-thinking counter reset", {
        sessionID,
        trigger: "successful_tool",
      });
    });

    await client.session.hook("context", async (event: any) => {
      const sessionID = stringValue(event.sessionID);
      if (!sessionID) return;
      await injectReminder(sessionID, event);
    });

    return () => {
      controller.abort();
      states.clear();
    };
  },
});

export default SequentialThinkingReminderPlugin;
