import type { Page } from "playwright";
import { openFloatingActionBar } from "@plugins/shell/plugins/global-action-bar/e2e";

/**
 * Switch the surface mode the way a user does: the action bar's gear, then
 * the Layout row's radio named by the mode's placement label ("Dock in tab
 * strip", "Fullscreen (solo)", "Desktop"). It is the ONE way to change mode —
 * there is no keyboard shortcut (Esc belongs to whatever is open). The control
 * acts on the tab set the user is in, so inside an embed it switches the embed.
 *
 * Docked, the gear sits in the tab bar; where the bar floats collapsed, its
 * row is `inert` until revealed, so open it first. Esc then closes the popover.
 */
export async function pickSurfaceMode(
  page: Page,
  label: string,
): Promise<void> {
  // The bar's gear — not a DataView toolbar's own "View options" button.
  const gear = page.locator('[data-ui-owner^="ViewOptionsButton@"]');
  const collapsed = await gear.evaluate((el) => el.closest("[inert]") !== null);
  if (collapsed) await openFloatingActionBar(page);
  await gear.click();
  await page.getByRole("radio", { name: label, exact: true }).click();
  await page.keyboard.press("Escape");
}
