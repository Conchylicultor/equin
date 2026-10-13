/**
 * Screenshot writing. ~20 of the pre-move scripts hand-wrote
 * `${out}-before.png` plus a `console.log("wrote …")` on every capture.
 */
import type { Page } from "playwright";
import { pushDiagnostic } from "./diagnostics";
import { flatness, hexColor } from "./pixels";
import { TOAST } from "./toasts";

/**
 * Cap on a single capture. Playwright's own default is 30s, and it awaits
 * `document.fonts.ready` before every screenshot — so a font that never
 * finishes loading turns a cosmetic capture into a half-minute stall and then a
 * TimeoutError. Ten seconds is far longer than a healthy capture needs.
 */
export const DEFAULT_SNAP_TIMEOUT_MS = 10_000;

export type SnapResult =
  { ok: true; path: string } | { ok: false; path: string; error: string };

/**
 * Write `${outPrefix}-${name}.png` and log the path (the transcript is how an
 * agent finds the image afterwards).
 *
 * A screenshot is a diagnostic, not an assertion, so this never throws: a
 * failure is reported loudly (here and again in `report().finish()`) but leaves
 * the run's verdict to the actual checks. The result is a discriminated union
 * rather than a nullable path so a caller that *does* care cannot mistake a
 * failure for a success.
 *
 * A capture that is ONE flat colour is a failure too (`BLANK-CAPTURE`): it is
 * the page before it painted, and a black rectangle reported as `wrote …` is
 * the most misleading thing a screenshot can hand an agent. The file is still
 * written, so it can be looked at. `allowBlank` is for the rare capture whose
 * subject really is a flat fill.
 *
 * `hideToasts` is for a picture meant to be shown (a gallery shot, docs), not
 * a diagnostic: the toasts are hidden by a style Playwright applies to this
 * capture only, so one that lands mid-capture is hidden too. What each one
 * said is still logged and recorded as a diagnostic — an error toast is a
 * finding, and leaving it out of the image must not lose it.
 */
export async function snap(
  page: Page,
  outPrefix: string,
  name: string,
  opts: { timeoutMs?: number; hideToasts?: boolean; allowBlank?: boolean } = {},
): Promise<SnapResult> {
  const path = `${outPrefix}-${name}.png`;
  try {
    if (opts.hideToasts) {
      for (const text of await page.locator(TOAST).allInnerTexts()) {
        const line = text.replace(/\s+/g, " ").trim();
        console.log(`TOAST-HIDDEN ${path} — ${line}`);
        pushDiagnostic(`toast hidden from ${path} — ${line}`);
      }
    }
    const png = await page.screenshot({
      path,
      timeout: opts.timeoutMs ?? DEFAULT_SNAP_TIMEOUT_MS,
      ...(opts.hideToasts && {
        style: `${TOAST} { visibility: hidden !important; }`,
      }),
    });
    if (!opts.allowBlank) {
      const verdict = await flatness(page, png);
      if (verdict.flat) {
        const error = `blank capture — every pixel is ${hexColor(verdict.color)}, the page had not painted`;
        console.log(`BLANK-CAPTURE ${path} — ${error}`);
        pushDiagnostic(`screenshot ${path} — ${error}`);
        return { ok: false, path, error };
      }
    }
    console.log(`wrote ${path}`);
    return { ok: true, path };
  } catch (err) {
    const error =
      err instanceof Error ? err.message.split("\n")[0]! : String(err);
    console.log(`SNAP-FAIL ${path} — ${error}`);
    pushDiagnostic(`screenshot ${path} — ${error}`);
    return { ok: false, path, error };
  }
}
