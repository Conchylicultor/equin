import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { defineExtension } from "@plugins/infra/plugins/entity-extensions/server";
import { conversationPrepromptShape } from "../../core";

// Snapshot of the task's selected preprompt at conversation-launch time. The
// title, text, and icon are copied (not just the id) so the chip reflects
// exactly what the agent was launched with, even if the config item later
// changes or is deleted. The body column is named `prompt_text` to avoid any
// ambiguity with the SQL `text` type, but the TS field stays `text`. `icon`
// holds the chosen avatar spec (a Material Symbols name + color), or
// null when the preprompt has no icon. The row itself is declared once, as
// `conversationPrepromptShape` in `core/internal/schemas.ts`.
export const conversationPreprompt = defineExtension(
  _conversations,
  "preprompt",
  conversationPrepromptShape,
  {
    columns: { text: { name: "prompt_text" } },
  },
);
// Re-export the underlying pgTable so drizzle-kit's schema glob picks it up.
export const _conversationPrepromptTable = conversationPreprompt.table;
