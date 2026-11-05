import type { Locator, Page } from "playwright";
import { ELEMENT_TIMEOUT_MS } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/**
 * Open the launcher drawn inside `scope` (a page, or an in-process app embed's
 * root) by hovering its mark, and return its Apps grid once the grid is
 * SETTLED: at least one tile drawn — the current app is always one, so a known
 * grid is never empty — and nothing in the panel still `aria-busy`.
 *
 * The panel is found through its own trigger (the mark's `aria-controls`),
 * never by its label: other controls are named "Apps" too (the Desktop shelf's
 * launcher button and its panel), so `[aria-label="Apps"]` can match one of
 * them — the Desktop's button stays visible once the launcher has closed.
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
  const mark = scope.getByRole("button", { name: "All apps" }).first();
  await mark.hover();
  // The trigger names its panel once it is open.
  await mark
    .and(page.locator('[aria-expanded="true"][aria-controls]'))
    .waitFor({ timeout: ELEMENT_TIMEOUT_MS });
  const panelId = await mark.getAttribute("aria-controls");
  if (panelId === null) throw new Error("the open launcher names no panel");
  const grid = page.locator(`[id="${panelId}"]`);
  await grid.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
  await launcherTiles(grid).first().waitFor({ timeout: ELEMENT_TIMEOUT_MS });
  await grid
    .locator('[aria-busy="true"]')
    .first()
    .waitFor({ state: "detached", timeout: ELEMENT_TIMEOUT_MS });
  return grid;
}

/**
 * Close a grid `openLauncherGrid` opened (Escape, pointer away) and wait until
 * it is gone, so the next hover never finds the closing one.
 */
export async function closeLauncherGrid(grid: Locator): Promise<void> {
  await grid.page().keyboard.press("Escape");
  await grid.page().mouse.move(0, 0);
  await grid.waitFor({ state: "hidden", timeout: ELEMENT_TIMEOUT_MS });
}

/** The grid's tiles — the icons DataView's activating rows. */
export function launcherTiles(grid: Locator): Locator {
  return grid.locator('[data-row-key][role="button"]');
}

/**
 * Open the launcher in `scope`, click the tile whose text matches `name` and
 * wait for the panel to be gone; `false` (the panel closed again) when the
 * settled grid has no such tile — the composition's home app, for one, is the
 * mark itself.
 */
export async function pickFromLauncher(
  scope: Page | Locator,
  name: RegExp,
): Promise<boolean> {
  const grid = await openLauncherGrid(scope);
  const tile = launcherTiles(grid).filter({ hasText: name }).first();
  const found = (await tile.count()) > 0;
  if (found) await tile.click();
  await closeLauncherGrid(grid);
  return found;
}
