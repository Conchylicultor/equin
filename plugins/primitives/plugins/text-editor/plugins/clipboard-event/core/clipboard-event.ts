import type { PasteCommandType } from "lexical";

/**
 * The `ClipboardEvent` a Lexical PASTE / COPY / CUT command carries, or `null`.
 * Their payloads are unions — PASTE `ClipboardEvent | InputEvent |
 * KeyboardEvent`, COPY / CUT `ClipboardEvent | KeyboardEvent | null` — and only
 * a `ClipboardEvent` holds `clipboardData`: an `InputEvent` paste or a
 * keyboard-dispatched copy does not. Narrowed by the property, not `instanceof`,
 * so it holds where `ClipboardEvent` is no global (jsdom).
 */
export function clipboardEventOf(
  event: PasteCommandType | ClipboardEvent | KeyboardEvent | null,
): ClipboardEvent | null {
  return event !== null && "clipboardData" in event ? event : null;
}
