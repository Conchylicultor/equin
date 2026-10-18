import type { FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { RelayQuestionsSchema } from "./schemas";

/**
 * A held question's fields, in column order — the `pending_questions` table is
 * built from them (`server/internal/tables.ts`), plus its server fields (the
 * relay's pid, the lifecycle, the answer, when it resolved), never on the wire.
 */
export const pendingQuestionFields = {
  toolUseId: textField(),
  conversationId: textField({ label: "Conversation" }),
  questions: jsonField({ schema: RelayQuestionsSchema, default: [] }),
  createdAt: dateField(),
} satisfies FieldsRecord;

/** The `pending_questions` entity — one row per AskUserQuestion call a relay held. */
export const pendingQuestionsEntityRef = entityRef(
  "pending_questions",
  pendingQuestionFields,
);
