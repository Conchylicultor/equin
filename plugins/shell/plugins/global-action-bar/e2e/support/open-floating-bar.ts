import type { Page } from "playwright";

/**
 * Open the floating action bar so its items take clicks.
 *
 * Fullscreen (solo) is the boot mode, where the bar floats collapsed to the
 * health dot: every other item sits in a zero-width reveal strip, so a click on
 * one (the bell, Build, …) is refused with `… intercepts pointer events`. The
 * bar opens on hover, so move the pointer onto the dot — a real pointer move,
 * not `locator.hover()`: the floating panel's own layer sits over the trigger
 * and would make `hover()` wait forever — and wait for the panel to report
 * itself revealed (`data-revealed`: open AND done morphing — `data-open` comes
 * first, while the items are still clipped at their collapsed spot, and a click
 * aimed there misses). A popover opened from an item then holds the bar open on
 * its own (`FloatingAction` is a popup-open scope).
 */
export async function openFloatingActionBar(page: Page): Promise<void> {
  const dot = page.locator("[data-health]").last();
  await dot.waitFor();
  const box = await dot.boundingBox();
  if (!box) throw new Error("health dot has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page
    .locator("[data-revealed]", { has: page.locator("[data-health]") })
    .waitFor();
}
