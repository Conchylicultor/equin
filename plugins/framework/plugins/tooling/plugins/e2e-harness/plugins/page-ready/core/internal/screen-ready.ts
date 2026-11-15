import type { Page } from "playwright";
import { waitForNotBusy } from "./busy";
import { flatness, type Rgba } from "./flatness";
import { waitForNetworkIdle } from "./network-idle";
import { ELEMENT_TIMEOUT_MS, waitFor } from "./wait";

/**
 * Whether a navigated page is ready to be captured — the ONE readiness rule a
 * capture of the deployed app applies, shared by `screenshot.ts` (e2e) and the
 * agent browser's `capturePair` (its host process):
 *
 *  1. **painted** — re-captured until the screen is more than one flat colour.
 *     An app still booting is its bare background; on a loaded machine (builds
 *     holding the CPU) that takes well over any fixed sleep — 4 s and 8 s both
 *     captured a black frame.
 *  2. **network idle** — the page's own requests (`waitForNetworkIdle`; the
 *     page must be tracked from its first request — `trackPageNetwork`).
 *  3. **no loader** — no visible `aria-busy` region (`waitForNotBusy`): work a
 *     page waits on can run where its requests do not show (a SharedWorker).
 *
 * `blank` is a page that never painted within the budget — never a capture to
 * hand back as evidence. `ready` with `stillBusy` non-empty settled its
 * network but still showed a loader at the deadline: the caller says so and
 * captures anyway (a loader is what the screen shows).
 */
export type ScreenReadiness =
  | { kind: "blank"; color: Rgba; waitedMs: number }
  | {
      kind: "ready";
      paintedAfterMs: number;
      /** Loaders still visible at the deadline (empty: none). */
      stillBusy: string[];
      busyWaitedMs: number;
    };

export async function waitForScreenReady(
  page: Page,
  opts: { timeoutMs?: number } = {},
): Promise<ScreenReadiness> {
  const timeoutMs = opts.timeoutMs ?? ELEMENT_TIMEOUT_MS;
  const painted = await waitFor(
    async () => flatness(page, await page.screenshot()),
    (v) => !v.flat,
    { timeoutMs, intervalMs: 500 },
  );
  if (painted.value.flat) {
    return {
      kind: "blank",
      color: painted.value.color,
      waitedMs: painted.waitedMs,
    };
  }
  await waitForNetworkIdle(page);
  const settled = await waitForNotBusy(page, { timeoutMs });
  return {
    kind: "ready",
    paintedAfterMs: painted.waitedMs,
    stillBusy: settled.ok ? [] : settled.value,
    busyWaitedMs: settled.waitedMs,
  };
}
