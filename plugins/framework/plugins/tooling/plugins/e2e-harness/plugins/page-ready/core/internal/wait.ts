/**
 * Waiting for the app to be RIGHT, rather than for a fixed number of
 * milliseconds and hoping.
 *
 * A fixed `waitForTimeout(5000)` after a navigation looks conservative and is
 * not. It is a claim about how long the app takes, made once, never measured,
 * and silently wrong forever after. Measured against `main` on an IDLE machine,
 * a second browser context needed **6391 ms** and **6237 ms** to render a
 * five-block page — while `crdt-offline-verify`, `crdt-newblock-verify` and
 * `crdt-typing-verify` each read the DOM at 5000 ms and asserted on what they
 * found. They were reading roughly a second and a half early. Two of them
 * reported cross-context convergence failures against `main` that were the
 * clock, not the app; the earlier attempt at scoping `page-block-doc` appears to
 * have been reverted over exactly that artifact. A wrong instrument does not
 * merely flake — it invents bugs and hides real ones.
 *
 * So: re-read until the condition holds, and treat the budget as a DEADLINE for
 * failure rather than a delay to pay. A condition wait returns the moment the
 * app is right, so a generous budget costs a healthy run nothing. Make budgets
 * generous: the default below is 45 s because the worst HEALTHY wait measured
 * against main — a second context re-hydrating a five-block page while three
 * other e2e scripts shared the machine — was 20.9 s. A budget is sized against
 * the loaded case, since the loaded case is the one that produces a false
 * failure; the idle case never reaches it.
 *
 * The shape differs from the inline precedent at
 * `plugins/page/plugins/editor/e2e/crdt-reopen-verify.ts:124` in three ways, all
 * deliberate — this is the argument, so it does not have to be had again:
 *
 *  1. **Read first, then sleep.** The precedent sleeps a full interval before
 *     its first read, so an app that was already ready still pays it. With
 *     several waits in one script that is dead time on every run, and the first
 *     read is the one that usually succeeds.
 *  2. **It returns the last value it saw**, so the failing assertion can print
 *     what the app actually showed instead of "timed out". The precedent gets
 *     this right by hoisting a `let` out of the loop; that is the property worth
 *     keeping, and worth keeping without the `let`.
 *  3. **It reports `waitedMs` and `attempts`.** Without them you cannot tell a
 *     check that passed instantly from one that passed at 19.9 s — the
 *     difference between a healthy app and one about to start failing for
 *     nobody's reason. The 6391 ms measurement above exists only because the
 *     wait reported it.
 *
 * It deliberately does NOT catch. A read that throws is a real failure — an
 * endpoint 500, a closed page — and retrying it would turn a loud error into a
 * timeout, which is the same silencing this helper exists to end.
 */

/**
 * Budget for a Playwright wait on an element the app has to RENDER before it
 * appears — `locator.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS })`.
 *
 * Not every wait should become a condition poll. Whether an element is on
 * screen is Playwright's own question, and it already re-checks rather than
 * sleeping; what it needs is a budget that is not a guess. This is that budget,
 * and it exists as ONE constant so the measurement travels with it: three
 * scripts each carried a hand-picked `timeout: 15000` / `20000`, and 15000 is
 * what failed on a loaded machine while the app was working correctly. Editing
 * three hand-picked numbers to three larger hand-picked numbers only resets the
 * clock on that same failure.
 *
 * 60 s against the 20.9 s worst HEALTHY wait measured on main (a second browser
 * context rendering a five-block page while three other e2e scripts shared the
 * machine). A budget is a deadline for declaring failure, not a delay: an
 * element that appears in 80 ms costs 80 ms, so the only thing a generous
 * number buys is not accusing a working app.
 */
export const ELEMENT_TIMEOUT_MS = 60_000;

/** The outcome of a bounded wait: whether it settled, and what it last saw. */
export interface Settled<T> {
  /** Did `ok(value)` hold before the deadline? */
  ok: boolean;
  /** The most recently read value — the one to print when `ok` is false. */
  value: T;
  waitedMs: number;
  attempts: number;
}

/**
 * Re-run `read` until `ok(value)` holds or the budget expires.
 *
 * Never throws on timeout: not-yet-true is a fact for the caller to report
 * through `report()`, alongside the value that made it false.
 */
export async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Settled<T>> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const intervalMs = opts.intervalMs ?? 250;
  const started = Date.now();
  let value = await read();
  let attempts = 1;
  while (!ok(value) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await read();
    attempts++;
  }
  return { ok: ok(value), value, waitedMs: Date.now() - started, attempts };
}
