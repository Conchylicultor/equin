import { InputNotEmptyError } from "@plugins/conversations/server";

// The verified-empty input box every typed turn starts from. The CLI submits
// whatever the box holds plus whatever is typed after it as ONE prompt — the
// 2026-10-15 incident, where a Push & Exit prompt Stop had left in the box and
// the user's next message went in together — so a turn may only be typed into
// a box read empty. The pane I/O is injected so the decision sequence is
// unit-tested against scripted captures (input-guard.test.ts).

// After C-c on a draft, how long the box may take to read empty (the same
// render-lag shape typeTurn's submit check waits out); for Stop, how long the
// CLI may take to put an interrupted turn back in the box before there is
// nothing to clear; and the cadence of both reads.
export const CLEAR_TIMEOUT_MS = 2_000;
export const RESTORE_APPEAR_TIMEOUT_MS = 1_500;
export const CLEAR_POLL_INTERVAL_MS = 75;

export interface InputBoxIo {
  /** The box's draft: `""` empty, `null` unreadable (captureInputDraft). */
  read(): Promise<string | null>;
  /** Send C-c, the CLI's "abort current line". */
  abortLine(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Leave the input box empty, or throw {@link InputNotEmptyError}.
 *
 * C-c on a draft discards the draft; sent into a WORKING agent with an empty
 * box it interrupts the response. So it is sent only for a draft the box really
 * holds (a web-driven send leaves the box empty and sends none), and exactly
 * ONCE: a second C-c on a box that only reads non-empty through render lag
 * lands on an empty prompt, where it arms the CLI's exit. Then the box is
 * polled until it reads empty.
 *
 * `awaitRestore` first waits for a draft to APPEAR (Stop: Escape before any
 * reply puts the turn back in the box, asynchronously). Returns the draft
 * cleared: `""` for none, `null` when the box could not be read — an
 * unrecognized render, which this cannot guard and typeTurn's own check
 * reports as unverified.
 */
export async function clearDraft(
  conversationId: string,
  awaitRestore: boolean,
  io: InputBoxIo,
): Promise<string | null> {
  let draft = await io.read();
  if (awaitRestore) {
    const deadline = io.now() + RESTORE_APPEAR_TIMEOUT_MS;
    while (!draft && io.now() + CLEAR_POLL_INTERVAL_MS < deadline) {
      await io.sleep(CLEAR_POLL_INTERVAL_MS);
      draft = await io.read();
    }
  }
  if (!draft) return draft;
  await io.abortLine();
  const deadline = io.now() + CLEAR_TIMEOUT_MS;
  let left: string | null;
  for (;;) {
    left = await io.read();
    if (left === "") return draft;
    if (io.now() + CLEAR_POLL_INTERVAL_MS >= deadline) break;
    await io.sleep(CLEAR_POLL_INTERVAL_MS);
  }
  throw new InputNotEmptyError(conversationId, left ?? draft);
}
