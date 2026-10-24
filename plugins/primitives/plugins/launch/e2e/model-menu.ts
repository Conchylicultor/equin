/**
 * Verifies the launch model menu draws through the shared menu row: one radio
 * row per model, the default the checked one, a plain-text mod+N shortcut, and
 * the row's launch action hidden at rest, shown on the highlighted row — with
 * every row exactly as tall as a plain menu row (the action must not stretch
 * it).
 *
 * Manual only. Run after `./equin build`:
 *   ./equin run plugins/primitives/plugins/launch/e2e/model-menu.ts [--out /tmp/model-menu] [--headed]
 */
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out", "/tmp/model-menu");
const r = report("launch model menu uses the shared menu row");

await withBrowser(async (h) => {
  const { page } = await h.session();
  await boot(page, pathUrl("/agents"), { settleMs: 2500 });

  // The sidebar's split launch control: the trigger is named by the default
  // model's label, so open the first dropdown trigger of the launch group.
  const trigger = page.locator('[data-slot="dropdown-menu-trigger"]').first();
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();

  const rows = menu.getByRole("menuitemradio");
  const count = await rows.count();
  r.ok("one radio row per model", count > 0, `rows=${count}`);
  if (count === 0) return;

  const checked = await menu
    .locator('[role="menuitemradio"][aria-checked="true"]')
    .count();
  r.ok(
    "exactly one row (the default) is checked",
    checked === 1,
    `checked=${checked}`,
  );

  const heights = await rows.evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height)),
  );
  const panelRowH = await menu.evaluate((el) =>
    Math.round(
      parseFloat(getComputedStyle(el).getPropertyValue("--panel-row-h")) *
        parseFloat(getComputedStyle(document.documentElement).fontSize),
    ),
  );
  r.ok(
    "every row is one panel row tall",
    heights.every((hh) => Math.abs(hh - panelRowH) <= 1),
    `heights=${heights.join(",")} --panel-row-h≈${panelRowH}px`,
  );

  const shortcut = rows.first().locator('[data-slot="dropdown-menu-shortcut"]');
  r.ok(
    "the shortcut is plain text, not a keycap",
    (await shortcut.count()) === 1 &&
      (await page.locator('[role="menu"] kbd').count()) === 0,
    `text=${await shortcut.first().innerText()}`,
  );

  const action = rows
    .first()
    .locator('[data-slot="dropdown-menu-item-action"]');
  const visibility = () =>
    action.evaluate((el) => getComputedStyle(el).visibility);
  // Highlight another row first, so the first one is not lit at rest.
  await rows.last().hover();
  r.ok(
    "the action is hidden on a resting row",
    (await visibility()) === "hidden",
  );
  await rows.first().hover();
  r.ok(
    "the action shows on the highlighted row",
    (await visibility()) === "visible",
  );
  await snap(page, OUT, "hover");

  await page.keyboard.press("ArrowDown");
  r.ok(
    "the action hides as soon as the highlight leaves its row",
    (await visibility()) === "hidden",
  );
  const lit = menu.locator('[role="menuitemradio"][data-highlighted]');
  const litAction = lit.locator('[data-slot="dropdown-menu-item-action"]');
  r.ok(
    "the action follows the keyboard highlight",
    (await litAction.count()) === 1 &&
      (await litAction.evaluate((el) => getComputedStyle(el).visibility)) ===
        "visible",
  );
  await snap(page, OUT, "keyboard");
});

await r.finish();
