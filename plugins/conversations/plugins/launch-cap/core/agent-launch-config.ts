import { defineConfig } from "@plugins/config_v2/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

// Host-wide cap on agents the auto-start queue runs at once. Lives in its
// own leaf, registered from a portable barrel (every host serves it), so the
// launcher (`conversations/server`) reads it and Settings shows it.
export const agentLaunchConfig = defineConfig({
  name: "agent-launch",
  fields: {
    maxConcurrent: intField({
      default: 6,
      min: 1,
      label: "Max concurrent auto-started agents",
      description:
        "How many agents may be starting or working at once before the auto-start queue waits for one to finish. Caps only tasks that start on their own (armed, automations, follow-ups); a launch you start yourself always runs.",
    }),
  },
});
