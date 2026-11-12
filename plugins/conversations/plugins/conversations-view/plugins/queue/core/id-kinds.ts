import { defineIdKind, type IdOf } from "@plugins/ids/core";

/**
 * A user-made sidebar section's id (`conversation_sections.id`), declared once
 * (`plugins/ids`): minted by `sections/create`, stored as a queue row's
 * `section` to file a task group into it.
 */
export const conversationSectionIdKind = defineIdKind({
  prefix: "csec",
  label: "Conversation section",
});

export type ConversationSectionId = IdOf<typeof conversationSectionIdKind>;
