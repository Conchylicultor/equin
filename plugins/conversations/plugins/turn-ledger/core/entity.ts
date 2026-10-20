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
 * built from them (`server/internal/tables.ts`), plus `typedText` and
 * `submittedText`, its server fields (never on the wire). `conversationId` is
 * the one a reader filters on; the rest is carried.
 */
export const ledgerTurnFields = {
  id: idKindField(turnIdKind),
  conversationId: textField({ label: "Conversation" }),
  kind: parsedTextField(TurnKindSchema, { default: "turn" }),
  /** What the user wrote, raw — for the draft and the echo. */
  text: textField(),
  state: parsedTextField(TurnStateSchema, { default: "held" }),
  /** `merged` only: the text the CLI submitted around this turn's. */
  extraText: nullable(textField()),
  /** `failed` / `unverified` (and kept by `withdrawn`): why. */
  error: nullable(textField()),
  /**
   * `accepted` / `merged`: when the agent took it — its `turn_started` event's
   * own time, so a late replay still records the agent's moment. The status
   * reconciler weighs it against the agent's own idle/busy write; the web
   * retires the turn's echo once the transcript reaches it.
   */
  submittedAt: nullable(dateField()),
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
