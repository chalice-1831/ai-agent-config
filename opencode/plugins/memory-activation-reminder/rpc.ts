import { Rpc } from "@opencode/plugin/rpc";

export const MemoryActivationReminderRpc = Rpc.define({
  id: "memory-activation-reminder",
  methods: {},
  events: {
    reminder: {
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
  },
});
