import type { Locator } from "playwright";

/**
 * The ids of the desktop windows `root` shows, sorted and de-duplicated (a
 * window's tab strip carries `data-floating-window-id`).
 *
 * Shown, not mounted: the surface keeps every mode it has visited mounted, the
 * inactive ones `display:none` under a React `<Activity>` — so after Full
 * screen the desktop's windows are still in the DOM, hidden. Counting mounted
 * windows would say the desktop never left.
 */
export async function shownWindowIds(root: Locator): Promise<string[]> {
  const ids = await root
    .locator("[data-floating-window-id]")
    .evaluateAll((els) =>
      els
        .filter((el) => el.checkVisibility())
        .map((el) => el.getAttribute("data-floating-window-id") ?? ""),
    );
  return [...new Set(ids)].sort();
}
