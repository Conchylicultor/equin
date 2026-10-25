import { defineConfig } from "@plugins/config_v2/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";
import { dynamicEnumField } from "@plugins/fields/plugins/dynamic-enum/plugins/config/core";
import { DEFAULT_MODEL_CHOICE } from "@plugins/conversations/plugins/model-provider/core";

/**
 * The default guidance the help agent follows on top of its built-in prompt:
 * every agent launch starts from the global action bar's Improve button.
 */
const DEFAULT_ASK_GUIDANCE = `- The global action bar (top right, on every app) is where the user starts anything an agent should do: changing a prototype, creating an app, fixing or improving what they see. When they want something done, point them to its **Improve** button (with \`<show-me>\` when it is on their screen) — it files a task from the page they are on and an agent picks it up — rather than to an app's own buttons.`;

/**
 * Ask equin's settings (Settings → Config). The two models are picked from the
 * live model catalog (the web barrel contributes their options); a stored
 * value is read through `normalizeModelChoice`. `guidance` is added to the
 * help agent's CLAUDE.md at each launch.
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
    guidance: multilineTextField({
      label: "Guidance",
      description:
        "Extra instructions the help agent follows when answering, added to its prompt at each new question (markdown). Empty for none.",
      default: DEFAULT_ASK_GUIDANCE,
      rows: 8,
    }),
  },
});
