// E2E verification: a ⌘-click (Ctrl elsewhere) while picking is a real click,
// so the picker reaches what only exists once opened — here a menu item.
//
// Arms the in-form picker ("Attach UI element", inside the Improve popover),
// ⌘-clicks a menu trigger on the page (the menu must open, and the popover the
// picker was armed from must stay open), then plain-clicks an item of that menu
// — which must be picked into the draft as a chip, not activated.
//
// Usage: ./singularity run plugins/improve/plugins/element-picker/e2e/pick-inside-menu.ts [--path <route>] [--headed]
import {
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = "/tmp/pick-inside-menu";

await withBrowser(async (h) => {
  const { page } = await h.session();
  await page.goto(pathUrl("/"), { waitUntil: "domcontentloaded" });

  // 1. Open the Improve popover and arm its in-form picker.
  const improve = page.getByRole("button", { name: "Improve" }).first();
  await improve.waitFor({ state: "attached", timeout: 30_000 });
  const bar = page.locator('[data-source*="floating-action"]').first();
  if (await bar.isVisible()) await bar.hover();
  await improve.click();
  const popover = page.locator('[data-slot="popover-content"]').first();
  await popover.waitFor({ state: "visible", timeout: 10_000 });
  const editor = popover.locator('[contenteditable="true"]').first();
  const chipsBefore = await editor
    .locator('button[contenteditable="false"]')
    .count();
  await popover
    .getByRole("button", { name: "Attach UI element" })
    .first()
    .click();
  const overlay = page.locator("[data-element-picker]").first();
  await overlay.waitFor({ state: "attached", timeout: 10_000 });

  // 2. ⌘-click a menu trigger outside the popover: a real click.
  const trigger = page
    .locator('[aria-haspopup="menu"]:visible')
    .filter({ hasNot: page.locator("[data-slot=popover-content]") })
    .first();
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  await trigger.click({ modifiers: ["ControlOrMeta"] });
  const menu = page.getByRole("menu").first();
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  await snap(page, OUT, "menu-open");
  const pickerStillArmed = await overlay.isVisible();
  const popoverStillOpen = await popover.isVisible();

  // 3. A plain click on a menu item picks it.
  const item = menu.getByRole("menuitem").first();
  const itemText = (await item.innerText()).trim();
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  await snap(page, OUT, "picked");
  const chipsAfter = await editor
    .locator('button[contenteditable="false"]')
    .count();

  const r = report("element-picker: ⌘-click opens a menu, click picks inside");
  r.note(`menu item: ${JSON.stringify(itemText)}`);
  r.ok("⌘-click opened the menu (picker stayed armed)", pickerStillArmed);
  r.ok("the Improve popover stayed open", popoverStillOpen);
  r.ok(
    "plain click on the menu item produced a chip",
    chipsAfter === chipsBefore + 1,
    `chips ${chipsBefore} → ${chipsAfter}`,
  );
  await r.finish();
});
