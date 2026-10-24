import { defineConfig } from "@plugins/config_v2/core";
import { dynamicEnumField } from "@plugins/fields/plugins/dynamic-enum/plugins/config/core";
import { DEFAULT_MODEL_CHOICE } from "@plugins/conversations/plugins/model-provider/core";

/**
 * Ask equin's settings (Settings → Config). Both are model choices picked from
 * the live model catalog (the web barrel contributes their options); a stored
 * value is read through `normalizeModelChoice`.
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
  },
});
