import type { KeptHandle } from "../core";

/**
 * When the field shows empty again:
 * - `"on-ack"` (default): it keeps showing what was sent until the send
 *   resolves `ok` — a form that disables itself while submitting (Wish, the
 *   task draft, Ask). A refused send leaves the text where it was.
 * - `"at-once"`: empty the moment it is submitted, so the field stays typable
 *   for the next message (the conversation prompt). The stored entry still
 *   holds what was sent until the ack, so a reload in between restores it.
 */
export type SubmitShows = "on-ack" | "at-once";

/**
 * Send what a kept entry holds and clear it only once the send is taken:
 * `send` resolves `{ ok: true }`. Until then the entry stays in storage, so a
 * reload between the click and the server's answer keeps the work instead of
 * losing it with the request. A rejected or `ok: false` send leaves the entry
 * as it is (a rejection is rethrown). A value typed since the submit is never
 * cleared — the clear holds only while the entry still stores what was sent.
 *
 * The one way to clear work after a send; the binding's `clear()` is for an
 * explicit discard.
 */
export async function submitKept<T, R extends { ok: boolean }>(
  handle: KeptHandle<T>,
  send: (value: T) => Promise<R>,
  options?: { shows?: SubmitShows },
): Promise<R> {
  const sent = handle.current();
  handle.flush();
  if (options?.shows === "at-once") handle.showInitial();
  const result = await send(sent);
  if (result.ok) handle.clearIfStill(sent);
  return result;
}
