/**
 * Let the app's toasts expire before a script drives a control they cover.
 *
 * A toast lands in the bottom-right corner of the window. So does a good deal
 * of what a script clicks — a popover's submit row, a composer bar's trailing
 * pill, a floating action button. When one is on screen, Playwright refuses the
 * click with `<li data-sonner-toast> … intercepts pointer events`, and the
 * failure reads like a broken selector rather than like "something is sitting
 * on top of it".
 *
 * The nasty part is that waiting does not help: Playwright's click retry holds
 * the pointer over the toast, and hovering the stack is exactly what a toast
 * reads as "someone is reading me" — its dismiss timer stays paused for as long
 * as the retry loop runs. So the click can never succeed, and the script burns
 * its whole timeout before saying anything. This was found the hard way by
 * `tasks/launch-options`' verify script, whose run pill sits under the toast
 * stack; it lives here so the next script does not have to find it again.
 *
 * Hence the two halves: park the pointer in the far corner FIRST, which lets
 * the timer run again, then give the stack a bounded chance to drain.
 *
 * **Not an assertion.** A notification is nothing a script is testing, so this
 * never fails a run: it waits, and records a non-fatal diagnostic if the stack
 * is still there. A toast that genuinely never clears still fails loudly at the
 * click below rather than letting the run pass quietly — this only removes the
 * case where the click could not have worked and the report blamed the wrong
 * thing.
 *
 * ```ts
 * await clearToasts(page);
 * await page.getByRole("button", { name: "Submit" }).click();
 * ```
 */
import type { Page } from "playwright";
import { pushDiagnostic } from "./diagnostics";
import { waitFor, type Settled } from "./wait";

/**
 * Every toast on screen. The attribute is sonner's own, which is what the app's
 * toast host (`shell/toast`) renders — named here once rather than in each
 * script that trips over one.
 */
export const TOAST = "[data-sonner-toast]";

/** The stack's Dismiss all strip (`shell/toast`'s host), shown beside 2+ toasts. */
export const TOAST_STRIP = "[data-toast-strip]";

/**
 * Default budget. Generous against a toast's own few-second lifetime, because a
 * healthy run pays nothing: the wait returns the moment the stack is empty, and
 * a page with no toast at all returns before waiting at all.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Wait out any toast covering the bottom-right corner.
 *
 * Returns what it last saw — `ok` with a final count of 0 when the stack
 * drained — so a caller that wants the timing in its transcript can print it.
 * Ignoring the result is fine: a stack that never cleared has already recorded
 * a diagnostic.
 */
export async function clearToasts(
  page: Page,
  opts: { timeoutMs?: number } = {},
): Promise<Settled<number>> {
  const toasts = page.locator(TOAST);
  const showing = await toasts.count();
  if (showing === 0) {
    return { ok: true, value: 0, waitedMs: 0, attempts: 1 };
  }
  // Out from under the stack before the clock can start: a pointer resting on a
  // toast is what keeps it alive.
  await page.mouse.move(4, 4);
  const settled = await waitFor(
    () => toasts.count(),
    (n) => n === 0,
    {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  );
  if (!settled.ok) {
    pushDiagnostic(
      `${settled.value} toast(s) still on screen after ${settled.waitedMs}ms — ` +
        `a click in the bottom-right corner may be intercepted`,
    );
  }
  return settled;
}
