import { type FieldsRecord } from "@plugins/fields/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { sessionLinkIdKind } from "./id-kind";

// One row per distinct Claude session id a conversation has ever run under, in
// first-seen order (`conversation_sessions`). `id` is an app-minted text PK
// (`sess-<uuid>`, no DB default); `seenAt` defaults to now() in the DB.
const conversationSessionFields = {
  id: idKindField(sessionLinkIdKind),
  conversationId: textField(),
  claudeSessionId: textField(),
  seenAt: dateField(),
} satisfies FieldsRecord;

/** The `conversation_sessions` entity. */
export const conversationSessionsEntityRef = entityRef(
  "conversation_sessions",
  conversationSessionFields,
);
