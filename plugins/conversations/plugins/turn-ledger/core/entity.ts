import type { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  parsedTextField,
  textField,
} from "@plugins/fields/plugins/text/plugins/config/core";
import { idKindField } from "@plugins/ids/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { turnIdKind } from "./id-kind";
import { TurnKindSchema, TurnStateSchema } from "./schemas";

/**
 * A ledger row's fields, in column order — the `conversation_turns` table is
 * built from them (`server/internal/tables.ts`), plus `typedText`, its server
 * field (never on the wire). `conversationId` is
 * the one a reader filters on; the rest is carried.
 */
export const ledgerTurnFields = {
  id: idKindField(turnIdKind),
  conversationId: textField({ label: "Conversation" }),
  kind: parsedTextField(TurnKindSchema, { default: "turn" }),
  /** What the user wrote, raw — for the draft and the echo. */
  text: textField(),
  state: parsedTextField(TurnStateSchema, { default: "held" }),
  /** `failed` (and kept by `withdrawn`): why. */
  error: nullable(textField()),
  /**
   * `accepted`: when the agent took it — its `turn_started` event's
   * own time, so a late replay still records the agent's moment. The status
   * reconciler weighs it against the agent's own idle/busy write.
   */
  submittedAt: nullable(dateField()),
  /**
   * Set with `submittedAt`: the uuid of the SDK user message the agent sent
   * this turn as, which its CLI started — the transcript entry's (a user
   * line's `uuid`, a prompt folded into a running turn's `source_uuid`): the
   * turn's identity in the transcript, which Stop / rewind and the web's echo
   * key on. Null for a turn confirmed before it was recorded.
   */
  promptUuid: nullable(textField()),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/** The `conversation_turns` entity — one row per turn sent to an agent. */
export const ledgerTurnsEntityRef = entityRef(
  "conversation_turns",
  ledgerTurnFields,
);

export const LedgerTurnSchema = fieldsToZodObject(ledgerTurnFields);
export type LedgerTurn = z.infer<typeof LedgerTurnSchema>;
