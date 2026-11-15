/**
 * Waiting for the page to stop SAYING it is loading.
 *
 * Network idle measures the page's own requests, not whether the app has what
 * it needs: work a page waits on can run where no page listener sees it — on
 * /demo the whole host boots in a SharedWorker, fetching its modules and then
 * building its database, while the page shows `Loading…` with nothing in
 * flight (see `network-idle.ts`). What the app does say is which regions are
 * still loading: every `Loading` (`primitives/loading`) is `aria-busy`, and a
 * surface without its data yet renders one ("not known yet is a state to
 * render"). So "settled" is: no visible `aria-busy` region left.
 */
import type { Locator, Page } from "playwright";
import { waitFor, type Settled } from "./wait";

/**
 * The visible `aria-busy` regions in `scope` (a page, or one region of it),
 * each named by its label or text — a hidden one (a kept-alive tab in the
 * background) is not what the page shows.
 */
export async function busyRegions(scope: Page | Locator): Promise<string[]> {
  return scope.locator('[aria-busy="true"]').evaluateAll((els) =>
    els
      .filter((el) => el.checkVisibility())
      .map((el) => {
        const label =
          el.getAttribute("aria-label") ?? (el.textContent || el.tagName);
        const text = label.replace(/\s+/g, " ").trim();
        return text.length > 60 ? `${text.slice(0, 60)}…` : text;
      }),
  );
}

/**
 * Re-read until no visible `aria-busy` region is left in `scope`. Never throws
 * on timeout: the result says whether it settled and which regions were still
 * loading, for the caller to report.
 */
export async function waitForNotBusy(
  scope: Page | Locator,
  opts: { timeoutMs?: number } = {},
): Promise<Settled<string[]>> {
  return waitFor(
    () => busyRegions(scope),
    (busy) => busy.length === 0,
    { timeoutMs: opts.timeoutMs },
  );
}
