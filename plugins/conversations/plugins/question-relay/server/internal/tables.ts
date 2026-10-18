import { index } from "drizzle-orm/pg-core";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { parsedTextField } from "@plugins/fields/plugins/text/plugins/config/core";
import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { pendingQuestionsEntityRef } from "../../core/entity";
import { CliAnswerSchema, RelayStateSchema } from "../../core/schemas";

// One row per AskUserQuestion call a relay hook held, keyed by the CLI's
// tool-use id (unique per call, and what the relay re-registers under after a
// backend restart). Built from `pendingQuestionFields` (core/entity.ts) plus
// the server fields below, which never reach the wire. `state` is the
// lifecycle in core/schemas.ts; `answer` is set with `answered`, in the tool's
// own input shape. The row is only the early copy of the question: once the CLI
// writes the tool_use and its result, the transcript is the authority.
export const pendingQuestionsEntity = defineEntity(
  pendingQuestionsEntityRef,
  {
    // The relay process holding the call; a dead pid is how a hold the
    // terminal killed (Escape, a dead agent or pane) is noticed.
    relayPid: intField(),
    state: parsedTextField(RelayStateSchema, { default: "open" }),
    answer: nullable(
      jsonField({ schema: CliAnswerSchema, default: { answers: {} } }),
    ),
    resolvedAt: nullable(dateField()),
  },
  {
    primaryKey: "toolUseId",
    columns: {
      conversationId: {
        references: { column: () => _conversations.id, onDelete: "cascade" },
      },
      createdAt: { default: defaultNow() },
    },
    indexes: (t) => [
      // The reconciler's "latest hold per conversation" read, and the web's
      // per-conversation window.
      index("pending_questions_conversation_idx").on(
        t.conversationId,
        t.createdAt,
      ),
      // The retention sweep's age column.
      index("pending_questions_resolved_at_idx").on(t.resolvedAt),
    ],
  },
);

export const _pendingQuestions = pendingQuestionsEntity.table;
