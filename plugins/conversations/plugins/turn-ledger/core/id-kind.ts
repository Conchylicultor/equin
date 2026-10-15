import { defineIdKind, type IdOf } from "@plugins/ids/core";

/**
 * One turn in the ledger (`conversation_turns.id`), declared once
 * (`plugins/ids`). A `uuid` kind: the browser mints it before it posts the
 * turn, which is what makes the post idempotent — a retried request finds the
 * row the first one wrote. The server mints one for a turn no browser sent
 * (Push & Exit from an older client, a held turn's flush never mints).
 */
export const turnIdKind = defineIdKind({
  prefix: "turn",
  label: "Turn",
  shape: "uuid",
});

export type TurnId = IdOf<typeof turnIdKind>;
