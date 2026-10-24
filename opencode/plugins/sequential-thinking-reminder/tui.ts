import { Plugin } from "@opencode/plugin/tui";
import { SequentialThinkingReminderRpc } from "./rpc";

type GuardEvent = {
  sessionID: string;
  message: string;
};

function sameLocation(
  event: { location?: { directory?: string } },
  location: { directory?: string },
): boolean {
  return event.location?.directory === location.directory;
}

export default Plugin.define({
  id: "sequential-thinking-reminder.tui",
  setup(context) {
    const guard = context.client.rpc(SequentialThinkingReminderRpc);
    const location = context.location ?? context.data.location.default();
    const active = guard.events.on("active", (event) => {
      if (!sameLocation(event, location)) return;
      const data = event.data as GuardEvent;
      context.ui.toast.show({
        title: "Sequential-thinking guard",
        message: data.message,
        variant: "info",
        sessionID: data.sessionID,
      });
    });
    const reminder = guard.events.on("reminder", (event) => {
      if (!sameLocation(event, location)) return;
      const data = event.data as GuardEvent;
      context.ui.toast.show({
        title: "Sequential-thinking reminder",
        message: data.message,
        variant: "warning",
        sessionID: data.sessionID,
      });
    });

    return () => {
      active();
      reminder();
    };
  },
});
