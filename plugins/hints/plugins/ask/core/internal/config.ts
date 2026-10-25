import { defineConfig } from "@plugins/config_v2/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";
import { dynamicEnumField } from "@plugins/fields/plugins/dynamic-enum/plugins/config/core";
import { DEFAULT_MODEL_CHOICE } from "@plugins/conversations/plugins/model-provider/core";
import {
  ASK_INSTRUCTIONS_TEMPLATE,
  ASK_INSTRUCTIONS_VARIABLES,
} from "./instructions";

/**
 * Ask equin's settings (Settings → Config). The two models are picked from the
 * live model catalog (the web barrel contributes their options); a stored
 * value is read through `normalizeModelChoice`. `instructions` is the help
 * agent's whole CLAUDE.md, filled at each launch — edit it here, then port the
 * edit back to {@link ASK_INSTRUCTIONS_TEMPLATE} to make it the default.
 */
export const askConfig = defineConfig({
  fields: {
    model: dynamicEnumField({
      label: "Model",
      description:
        "The model that answers your questions. Sonnet answers fastest; a stronger model digs deeper.",
      default: "sonnet",
    }),
    taskModel: dynamicEnumField({
      label: "Model for filed tasks",
      description:
        "The model a task Ask equin files for you launches with (in its own worktree, at once).",
      default: DEFAULT_MODEL_CHOICE,
    }),
    instructions: multilineTextField({
      label: "Instructions",
      description: `The help agent's whole prompt (its CLAUDE.md), read at each new question. Filled per question: ${ASK_INSTRUCTIONS_VARIABLES.map((v) => `{{${v.name}}} (${v.description})`).join(", ")}.`,
      default: ASK_INSTRUCTIONS_TEMPLATE,
      rows: 24,
    }),
  },
});
