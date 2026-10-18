import type { Session } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openFloatingActionBar } from "@plugins/shell/plugins/global-action-bar/e2e";

type Page = Session["page"];

/**
 * Turn layout edit mode on or off the way a user does, and resolve once it is
 * in that state — or throw, since a script that went on in the wrong mode
 * would read a vacuous zero.
 *
 * On is the Edit layout switch in the action bar's View options popover
 * (flipping it closes the popover). Off is Esc, the exit-edit-mode shortcut:
 * in edit mode the gear is itself a sortable item whose content takes no
 * clicks, so the switch cannot be reached again.
 *
 * The state is read off the editor's own chrome, which only edit mode draws:
 * every area shows a Hide item badge, an Add items button, or (a row too
 * narrow to edit in place) the Edit layout button opening its popover. Not on
 * a page that embeds a standalone editor (Settings → Config's reorder field),
 * which draws that chrome at rest.
 */
export async function setEditMode(page: Page, on: boolean): Promise<void> {
  if ((await isEditMode(page)) === on) return;
  if (on) {
    await openViewOptions(page);
    const toggle = page.getByRole("switch", {
      name: "Edit layout",
      exact: true,
    });
    await toggle.click();
    await toggle.waitFor({ state: "hidden", timeout: 10_000 });
  } else {
    // Off the bar first: an open floating bar takes Esc as its own close.
    await page.mouse.move(0, (page.viewportSize()?.height ?? 800) / 2);
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.keyboard.press("Escape");
  }
  await page
    .locator(EDITOR_CHROME)
    .first()
    .waitFor({ state: on ? "attached" : "detached", timeout: 10_000 });
}

const GEAR = 'button[aria-label="View options"]';
const EDITOR_CHROME = [
  '[aria-label="Hide item"]',
  '[aria-label="Add items"]',
  'button[aria-label="Edit layout"]',
].join(", ");

async function isEditMode(page: Page): Promise<boolean> {
  await page.locator(GEAR).first().waitFor({ state: "attached" });
  return (await page.locator(EDITOR_CHROME).count()) > 0;
}

async function openViewOptions(page: Page): Promise<void> {
  // Collapsed, the floating bar's items are laid out but its own layer takes
  // their clicks, so "is the gear visible" cannot tell; whether a floating bar
  // exists can. Docked, there is none and the gear is already clickable.
  if (await page.locator('[data-source*="floating-action"]').count()) {
    await openFloatingActionBar(page);
  }
  await page.locator(GEAR).first().click();
}
