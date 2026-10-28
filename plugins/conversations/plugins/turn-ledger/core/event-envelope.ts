import type { TurnKind } from "./schemas";

// The wire form of an `event` turn. What an agent is typed for one is its body
// inside ONE envelope, so the transcript — which only sees the text the CLI
// wrote — can tell an event from a message the user typed (transcript-source's
// parser draws it as an `event-turn`, and a rewind never cuts at it).
//
// The ledger applies it (`typedTextOf`, at accept), never a sender: a caller of
// `submitTurn` passes the raw body, so no event can reach an agent bare.

/** The envelope's tag. */
const EVENT_TURN_TAG = "equin-event";

const OPEN = `<${EVENT_TURN_TAG}>`;
const CLOSE = `</${EVENT_TURN_TAG}>`;
const ENVELOPE_RE = new RegExp(`^${OPEN}\\n?([\\s\\S]*?)\\n?${CLOSE}$`);

/** `body` inside the event envelope. */
export function wrapEventTurn(body: string): string {
  return `${OPEN}\n${body}\n${CLOSE}`;
}

/**
 * The body of `text` when the whole of it (surrounding whitespace aside) is
 * one event envelope, else null — a message that merely mentions the tag is
 * the user's own.
 */
export function unwrapEventTurn(text: string): string | null {
  const m = ENVELOPE_RE.exec(text.trim());
  return m ? m[1]! : null;
}

/** What reaches the CLI for a turn of `kind` whose typed text is `typedText`. */
export function typedTextOf(kind: TurnKind, typedText: string): string {
  return kind === "event" ? wrapEventTurn(typedText) : typedText;
}
