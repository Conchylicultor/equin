import { symbol } from "./icon-ref";

/**
 * The icon a status wears, named by WHAT STATE it is in — so a run, a task, an
 * agent and a job that are all "in flight" draw the same glyph, and swapping
 * the glyph for a state is one edit here. A status list maps each of its own
 * values to one of these (`running: { label, variant, icon: stateIcons.working }`);
 * its colour (`variant`) stays its own.
 *
 * - `working` — in flight right now: running, working, in progress, starting.
 *   Spins while drawn (stilled under reduced motion): `<Icon>` honours the
 *   ref's `spin`, so no call site animates it by hand.
 * - `needsYou` — stopped until a person acts: needs approval, need action,
 *   waiting on the user. (A raised hand.)
 * - `done` — finished, did what it set out to do.
 * - `failed` — finished, did not do it.
 * - `partial` — finished, did some of it (or ended without landing).
 * - `canceled` — ended without a verdict: dropped, superseded, gone, disabled.
 * - `paused` — held, blocked, handed off: will resume, not running now.
 * - `notStarted` — new, never run, not run here.
 *
 * The glyphs only a state can mean are reserved: `icons/reserved-state-icon`
 * rejects spelling them with `symbol(…)` anywhere but here. The others
 * (`check-circle`, `error`, `cancel`, `pause-circle`,
 * `radio-button-unchecked`) also draw ordinary controls and banners, so they
 * stay spellable — a status list still takes them from here.
 */
export const stateIcons = {
  working: { ...symbol("progress-activity"), spin: true },
  needsYou: symbol("front-hand"),
  done: symbol("check-circle"),
  failed: symbol("error"),
  partial: symbol("incomplete-circle"),
  canceled: symbol("cancel"),
  paused: symbol("pause-circle"),
  notStarted: symbol("radio-button-unchecked"),
} as const;

/** Each reserved glyph → the `stateIcons` key that owns it. */
export const RESERVED_STATE_GLYPHS: Readonly<Record<string, string>> = {
  "progress-activity": "working",
  "front-hand": "needsYou",
  "incomplete-circle": "partial",
};
