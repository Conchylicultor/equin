import {
  defineConfig,
  defineConfigMigration,
  type JsonValue,
} from "@plugins/config_v2/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { listField } from "@plugins/fields/plugins/list/plugins/config/core";
import { multilineTextField } from "@plugins/fields/plugins/multiline-text/plugins/config/core";
import {
  avatarField,
  migrateClassicAvatar,
} from "@plugins/fields/plugins/avatar/plugins/config/core";

// Library of named preprompts. Each item's text is added to the agent's system
// prompt, after Claude Code's own (wrapped in a `<special_instructions>`
// block), when a task that selects it launches an agent. Mirrors the prompt-templates config (a
// listField of { title, prompt }), but feeds the launch instead of the prompt
// editor.
type JsonObject = { [key: string]: JsonValue };
const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `preprompts[].icon` onto Material Symbols names (see migrateClassicAvatar). */
const remapIcons = defineConfigMigration({
  id: "saved-icons-to-symbols",
  apply: (doc) =>
    isObject(doc) && Array.isArray(doc.preprompts)
      ? {
          ...doc,
          preprompts: doc.preprompts.map((p) =>
            isObject(p) && p.icon !== undefined
              ? { ...p, icon: migrateClassicAvatar(p.icon) }
              : p,
          ),
        }
      : doc,
});

export const prepromptsConfig = defineConfig({
  migrations: [remapIcons],
  fields: {
    preprompts: listField({
      label: "Preprompts",
      description:
        "Instruction snippets added to a task's agent system prompt, after Claude Code's own, as a <special_instructions> block.",
      itemFields: {
        icon: avatarField({
          label: "Icon",
          description:
            "Shown as a marker on conversations launched with this preprompt.",
        }),
        title: textField({ label: "Title" }),
        prompt: multilineTextField({ label: "Prompt" }),
      },
      default: [],
    }),
  },
});
