// Opening a table grip's menu keeps the page where it is and the keyboard in
// the menu.
//
// Repro of "clicking the column menu makes the page jump": the menu portals to
// `document.body` and takes focus; that focus bubbles through React to the
// table's caret host, which makes the table the current block, and the host's
// pull-focus asked "is focus already inside me?" of the DOM — where the portaled
// menu is not — so it pulled focus back onto itself with a scrolling
// `.focus()`. The page scrolled the (tall) table into view, and the menu lost
// the keyboard.
//
// Asserts, on a scrolled page with a table taller than the viewport:
//   a. the scroller does not move when the column menu opens;
//   b. the menu is open and holds DOM focus;
//   c. Escape in the menu closes it (after its tooltip) without the table's
//      own Escape (block selection) running — a key typed in a portaled menu
//      is the menu's.
//
// Usage: ./equin run plugins/page/plugins/table/e2e/grip-menu-focus-verify.ts [--out /tmp/grip-menu-focus]
import {
  ELEMENT_TIMEOUT_MS,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/grip-menu-focus");
const r = report();

const ROWS = 40;
const GFM = [
  "| Fruit | Qty |",
  "| --- | --- |",
  ...Array.from({ length: ROWS }, (_, i) => `| fruit ${i} | ${i} |`),
].join("\n");

await withBrowser(async (h) => {
  const { context, page } = await h.session({ label: "grip-menu-focus" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1100, height: 700 });
  await openBlankPage(page, { settleMs: 2000 });
  // Lines above, so the page can be scrolled with the table's top in view.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.type(`filler line ${i}`);
    await page.keyboard.press("Enter");
  }
  await page.evaluate((text) => navigator.clipboard.writeText(text), GFM);
  await page.keyboard.press("Meta+v");
  const table = page.locator("[data-block-id] table").first();
  await table.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(1500);

  // The table's top a third of the way down, its bottom far below the fold.
  await table.evaluate((t) => {
    let s: HTMLElement | null = t.parentElement;
    while (
      s &&
      !(
        s.scrollHeight > s.clientHeight + 5 &&
        /auto|scroll/.test(getComputedStyle(s).overflowY)
      )
    )
      s = s.parentElement;
    if (!s) throw new Error("no scroller around the table");
    s.setAttribute("data-e2e-scroller", "");
    s.scrollTop += t.getBoundingClientRect().top - 250;
  });
  await page.waitForTimeout(500);
  const scrollTop = () =>
    page
      .locator("[data-e2e-scroller]")
      .evaluate((s) => Math.round(s.scrollTop));

  await table.getByText("Fruit", { exact: true }).hover();
  const before = await scrollTop();
  await page.getByRole("button", { name: /^Column 1 — drag to move/ }).click();
  const menu = page.getByLabel("Column actions");
  await menu.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(500);
  const after = await scrollTop();
  r.ok(
    `a: the page does not move when the menu opens (scrollTop ${before} → ${after})`,
    Math.abs(after - before) <= 2,
  );
  r.ok(
    "b: the open menu holds the keyboard",
    await menu.evaluate((m) => m.contains(document.activeElement)),
  );
  await snap(page, out, "menu-open");

  // Escape closes the innermost layer first: focusing the menu's first control
  // (Align → Left) shows its tooltip, which the first press dismisses.
  for (let i = 0; i < 3 && (await menu.isVisible()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
  await menu.waitFor({ state: "hidden", timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(300);
  r.eq(
    "c: Escape in the menu closes it and selects no block",
    await page.locator("[data-selection-band] > *").count(),
    0,
  );
});

await r.finish();
