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

/**
 * The uuid of the transcript line turn `id` becomes: the id's own uuid. The
 * sdk agent queues a turn's SDK user message under it, so whoever holds the
 * turn id finds its line in the transcript directly — the echo retires the
 * moment the line is on screen, without waiting for the ledger's confirmation
 * to reach the same tab on its own channel. An agent started before this
 * names its line with a fresh uuid (only the ledger's `promptUuid` knows it).
 */
export function transcriptUuidOfTurn(id: TurnId): TranscriptUuid {
  const uuid = id.slice(`${turnIdKind.prefix}-`.length);
  if (!isTranscriptUuid(uuid))
    throw new Error(`Turn id ${id} does not carry a uuid`);
  return uuid;
}

/** A transcript line's uuid — the shape Claude Code (and the SDK) name a message by. */
export type TranscriptUuid =
  `${string}-${string}-${string}-${string}-${string}`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTranscriptUuid(value: string): value is TranscriptUuid {
  return UUID_RE.test(value);
}
