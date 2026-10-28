import { defineIdKind } from "@plugins/ids/core";

/** One raised flag (`conversation_flags.id`). */
export const conversationFlagIdKind = defineIdKind({
  prefix: "cflag",
  label: "Flag",
  shape: "uuid",
});
