import { Plugin } from "@opencode/plugin/tui";
import { MemoryActivationReminderRpc } from "./rpc";

export default Plugin.define({
  id: "memory-activation-reminder.tui",
  setup(context) {
    const reminders = context.client.rpc(MemoryActivationReminderRpc);
    return reminders.events.on("reminder", (event) => {
      const location = context.location ?? context.data.location.default();
      if (event.location.directory !== location.directory) return;
      const data = event.data as { sessionID: string; message: string };
      context.ui.toast.show({
        title: "Memory activation",
        message: data.message,
        variant: "warning",
        sessionID: data.sessionID,
      });
    });
  },
});
