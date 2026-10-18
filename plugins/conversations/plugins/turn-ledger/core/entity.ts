import type { z } from "zod";
import {
  fieldsToZodObject,
  nullable,
  type FieldsRecord,
} from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
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
  /**
   * No hook will ever confirm this row — its session was launched without the
   * ledger's hook, or the text is a `/` command or `!` shell line, which the CLI
   * does not report. Its `typed` is final and means delivered.
   */
  hookless: boolField(),
  /** `merged` only: the text the CLI submitted around this turn's. */
  extraText: nullable(textField()),
  /** `failed` / `unverified` (and kept by `withdrawn`): why. */
  error: nullable(textField()),
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
