import { Rpc } from "@opencode/plugin/rpc";

export const SequentialThinkingReminderRpc = Rpc.define({
  id: "sequential-thinking-reminder",
  methods: {},
  events: {
    active: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          message: { type: "string" },
        },
        required: ["sessionID", "message"],
        additionalProperties: false,
      },
    },
    reminder: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          message: { type: "string" },
          thoughtCount: { type: "number" },
          level: { type: "number" },
        },
        required: ["sessionID", "message", "thoughtCount", "level"],
        additionalProperties: false,
      },
    },
  },
});
