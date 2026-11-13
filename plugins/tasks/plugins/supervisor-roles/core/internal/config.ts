import { defineConfig } from "@plugins/config_v2/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";

/**
 * The shared supervisor prompt: what every supervisor session's root is told,
 * ad-hoc supervisors (the Supervisor launch option) and role sessions alike —
 * before a role session's own brief (its role's prompt, the task it starts
 * with) and any per-task preprompt. Workers below a root never get it.
 */
export const supervisorPromptConfig = defineConfig({
  name: "Supervisors",
  fields: {
    prompt: multilineTextField({
      label: "Shared supervisor prompt",
      description:
        "What every supervisor session is told at its root (ad-hoc supervisors and every role's sessions), ahead of the role's own prompt. Empty: nothing.",
      default: "",
      rows: 12,
    }),
  },
});
