// The app launcher, end to end on a deployed build (Agent Manager's sidebar
// header):
//
//  1. Hovering the launcher mark opens the Apps grid; hovering the app name
//     does not.
//  2. The pointer crossing from the mark into the panel keeps it open; leaving
//     both closes it.
//  3. ArrowDown on the focused mark opens it with focus on the current app's
//     tile (marked aria-current); Home / ArrowRight / ArrowDown move through
//     the grid; Esc closes and returns focus.
//  4. Clicking the app name on a sub-route goes to the app's base path.
//  5. Clicking a tile switches to that app; clicking the mark goes to the
//     gallery.
//
// Usage:
//   ./equin run plugins/apps-core/plugins/app-launcher/e2e/launcher.ts [--headed]

import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/app-launcher";

const r = report("app launcher");

await withBrowser(async (h) => {
  const { page } = await h.session({ colorScheme: "dark" });
  await page.goto(pathUrl("/agents"));
  const mark = page.getByRole("button", { name: "All apps" }).first();
  await mark.waitFor();
  // The popover panel (HoverPopover labels it), and its tiles — the icons
  // DataView's activating tiles.
  const menu = page.locator('[aria-label="Apps"]');
  const tiles = menu.locator('[data-row-key][role="button"]');

  // 1. Hover the name: nothing opens.
  // The name button sits right after the mark in the header row (the rail's
  // own "Agent Manager" button comes first in the DOM, so no role lookup).
  const name = mark.locator("xpath=following-sibling::button[1]");
  await name.hover();
  await page.waitForTimeout(500);
  r.eq("hovering the app name opens nothing", await menu.count(), 0);

  // Hover the mark: the grid opens after the intent delay.
  await mark.hover();
  await menu.waitFor({ timeout: 2000 });
  const tileCount = await tiles.count();
  r.ok("hovering the mark opens the Apps grid", tileCount > 0, `${tileCount}`);
  r.note(`tiles: ${tileCount}`);
  await snap(page, OUT, "1-hover-open");

  // 2. Cross into the panel: still open after the grace.
  await tiles.first().hover();
  await page.waitForTimeout(500);
  r.ok("crossing into the panel keeps it open", await menu.isVisible());

  // Leave both: closes. Wait for the close itself (the grace delay plus the
  // exit animation) rather than a fixed sleep, so a slow frame cannot flake it.
  await page.mouse.move(900, 600, { steps: 5 });
  const closed = await menu.waitFor({ state: "hidden", timeout: 3000 }).then(
    () => true,
    (err: unknown) => {
      if (err instanceof Error && err.name === "TimeoutError") return false;
      throw err;
    },
  );
  r.note(
    `after leaving: expanded=${await mark.getAttribute("aria-expanded")} menus=${await menu.count()}`,
  );
  await snap(page, OUT, "2-left");
  r.ok("leaving both closes it", closed);

  // 3. Keyboard.
  await mark.focus();
  await page.keyboard.press("ArrowDown");
  await menu.waitFor({ timeout: 2000 });
  const focusedKey = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-row-key"));
  // The popover moves focus in once it has opened — wait for it to land.
  await page.waitForFunction(
    () => document.activeElement?.hasAttribute("data-row-key") === true,
    undefined,
    { timeout: 2000 },
  );
  const current = menu.locator('[aria-current="true"]');
  r.eq("the current app's tile is marked", await current.count(), 1);
  r.eq(
    "ArrowDown focuses the current app's tile",
    await focusedKey(),
    await current.getAttribute("data-row-key"),
  );
  const keys = await tiles.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-row-key")),
  );
  await page.keyboard.press("Home");
  r.eq("Home moves to the first tile", await focusedKey(), keys[0]);
  await page.keyboard.press("ArrowRight");
  r.eq("ArrowRight moves to the next tile", await focusedKey(), keys[1]);
  // The popover holds four tiles a row: ArrowDown from the second lands on
  // the sixth (when there is one).
  if (keys.length > 5) {
    await page.keyboard.press("ArrowDown");
    r.eq("ArrowDown moves one row down", await focusedKey(), keys[5]);
  }
  await snap(page, OUT, "3-keyboard");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  r.ok("Esc closes", !(await menu.isVisible()));
  r.ok(
    "Esc returns focus to the mark",
    await mark.evaluate((el) => el === document.activeElement),
  );

  // 4. The name on a sub-route goes to the app's base path.
  await page.goto(pathUrl("/agents/tasks"));
  await name.waitFor();
  await name.click();
  await page.waitForTimeout(800);
  r.eq(
    "the app name goes to the app's home",
    new URL(page.url()).pathname,
    "/agents",
  );

  // 5. A tile switches app.
  await mark.hover();
  await menu.waitFor({ timeout: 2000 });
  const target = tiles.filter({ hasText: "Settings" });
  await target.click();
  await page.waitForTimeout(1200);
  r.ok(
    "a tile switches to that app",
    new URL(page.url()).pathname.startsWith("/settings"),
    page.url(),
  );
  await snap(page, OUT, "5-switched");

  // The mark goes to the gallery.
  await page.goto(pathUrl("/agents"));
  await mark.waitFor();
  await mark.click();
  await page.waitForTimeout(1200);
  r.eq("the mark goes to the gallery", new URL(page.url()).pathname, "/home");
  await snap(page, OUT, "6-gallery");
});

await r.finish();
