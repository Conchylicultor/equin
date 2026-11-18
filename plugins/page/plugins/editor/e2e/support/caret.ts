/**
 * Reading and WALKING TO the caret's linear offset inside a block.
 *
 * **Presses are not offsets in this editor.** A mark boundary is a caret
 * position (the virtual delimiter — see the editor's CLAUDE.md), so one press at
 * a seam ARMS the pending mark and moves nothing: `keystroke-intent.ts` tries
 * `markStepFor` before the ordinary move, and `$markStep` records the pending
 * format without touching an offset. A fixture that counts nine ArrowRights to
 * land at offset 9 therefore lands at 8 the day a seam appears in its text, and
 * the failure surfaces one character downstream — as a content diff in whatever
 * the fixture did next, never at the walk that caused it.
 *
 * `pressUntilOffset` is what prevents that: it walks to a MEASURED offset and
 * throws when it cannot reach it. Counting presses is the bug this module
 * exists to make unwritable.
 *
 * **There are deliberately TWO walkers, and they must not be merged.**
 *
 * - `pressUntilOffset` is PLACEMENT. It gets a fixture to a position so the
 *   real assertions can run; arriving is a precondition, so failing to arrive
 *   THROWS.
 * - `pressUntilLinear` is MEASUREMENT. The press COUNT is itself the assertion
 *   (`mark-boundary-verify.ts` phase 6 asks how many presses a seam costs), so
 *   it checks BEFORE pressing — stopping the moment it reads the target, never
 *   spending the absorbed press the spec is about to measure — and returns `-1`
 *   on exhaustion, a value its callers assert on rather than a swallowed
 *   failure.
 *
 * `caretLinear` is lifted verbatim from `mark-boundary-verify.ts`, whose own
 * doc-comment already noted `backspace-indent-verify.ts` holding the same read —
 * the third copy, which is exactly where the cmd-b work drew the line when it
 * lifted `settledRuns` into `support/runs.ts`.
 */
import type { Page } from "playwright";

/**
 * The caret's linear offset inside its own block, or -1 when it is not in one.
 *
 * It is the ONLY caret fact the DOM can give a mark-boundary spec: a virtual
 * stop and the natural position it shadows are the same linear offset and the
 * same pixel, and `selection.format` — the thing that actually differs — is not
 * exposed at all.
 */
export async function caretLinear(page: Page): Promise<number> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return -1;
    const anchor = sel.anchorNode;
    const editable =
      anchor.parentElement?.closest?.("[data-block-text]") ??
      (anchor instanceof Element ? anchor.closest("[data-block-text]") : null);
    if (!editable) return -1;
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.setEnd(anchor, sel.anchorOffset);
    return range.toString().length;
  });
}

export interface PressUntilOffsetOptions {
  /** Bound on the walk. Reaching it is a THROW, never a quiet stop. */
  maxPresses?: number;
  /**
   * Settle after each press. Lexical absorbs a native caret move via
   * `selectionchange`, so its internal selection lags the DOM under a rapid
   * synthetic key burst — the 60ms cadence the existing drivers walk at.
   */
  settleMs?: number;
}

/**
 * Press ArrowRight until the caret's MEASURED linear offset reads `target`.
 *
 * Throws naming both the target and the offset actually reached — a walk that
 * cannot arrive is a caret regression, and the driver that called it is about to
 * assert something about a position it never stood at.
 */
export async function pressUntilOffset(
  page: Page,
  target: number,
  { maxPresses = 40, settleMs = 60 }: PressUntilOffsetOptions = {},
): Promise<void> {
  let at = await caretLinear(page);
  for (let presses = 0; presses < maxPresses && at !== target; presses++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(settleMs);
    at = await caretLinear(page);
  }
  if (at !== target) {
    throw new Error(
      `caret never reached linear offset ${target} — stopped at ${at} after ${maxPresses} ArrowRight presses`,
    );
  }
}

/**
 * Press `key` until the caret's linear offset reads `target`, returning how many
 * presses that took (-1 if it never did).
 *
 * Used only to WALK TO a fixture position, never to assert one: a press absorbed
 * by a virtual stop is exactly what `mark-boundary-verify.ts` phase 6 is
 * measuring, so the walk must not silently depend on the count it is about to
 * test. It checks before pressing, which is what stops it spending that press.
 */
export async function pressUntilLinear(
  page: Page,
  key: string,
  target: number,
  maxPresses = 12,
): Promise<number> {
  for (let presses = 0; presses <= maxPresses; presses++) {
    if ((await caretLinear(page)) === target) return presses;
    await page.keyboard.press(key);
    await page.waitForTimeout(80);
  }
  return -1;
}
