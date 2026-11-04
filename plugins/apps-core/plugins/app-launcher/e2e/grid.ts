import type { Locator, Page } from "playwright";
import { ELEMENT_TIMEOUT_MS } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/**
 * Open the launcher drawn inside `scope` (a page, or an in-process app embed's
 * root) by hovering its mark, and return its Apps grid once the grid is
 * SETTLED: at least one tile drawn — the current app is always one, so a known
 * grid is never empty — and nothing in the panel still `aria-busy`.
 *
 * The panel opens before its grid is known (the app listing and the grid's
 * view config load behind a loading state), so reading the tiles the moment
 * the panel appears reads the loading state, not the grid: a tile that is
 * about to be drawn reads as absent. That is what made the demo scripts report
 * "the launcher does not offer Prototypes" on 3 runs in 7.
 */
export async function openLauncherGrid(
  scope: Page | Locator,
): Promise<Locator> {
  const page = "page" in scope ? scope.page() : scope;
  await scope.getByRole("button", { name: "All apps" }).first().hover();
  // HoverPopover labels its panel; the last one is the one just opened.
  const grid = page.locator('[aria-label="Apps"]').last();
  await grid.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
  await launcherTiles(grid).first().waitFor({ timeout: ELEMENT_TIMEOUT_MS });
  await grid
    .locator('[aria-busy="true"]')
    .first()
    .waitFor({ state: "detached", timeout: ELEMENT_TIMEOUT_MS });
  return grid;
}

/** The grid's tiles — the icons DataView's activating rows. */
export function launcherTiles(grid: Locator): Locator {
  return grid.locator('[data-row-key][role="button"]');
}

/**
 * Open the launcher in `scope` and click the tile whose text matches `name`;
 * `false` (the panel closed again with Escape) when the settled grid has no
 * such tile — the composition's home app, for one, is the mark itself.
 */
export async function pickFromLauncher(
  scope: Page | Locator,
  name: RegExp,
): Promise<boolean> {
  const grid = await openLauncherGrid(scope);
  const tile = launcherTiles(grid).filter({ hasText: name }).first();
  if ((await tile.count()) === 0) {
    await grid.page().keyboard.press("Escape");
    return false;
  }
  await tile.click();
  return true;
}
