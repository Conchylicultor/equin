// Cmd/Ctrl+A's two-step ladder, in a real browser, from every kind of caret:
// the first press selects the text the caret is in; once there is no more text
// to select, the press selects every block. See
// `web/internal/select-all-ladder.ts`.
//
//   1. a text block: text first, every block second;
//   2. an empty text block: every block at once;
//   3. a divider (the editor's caret box): every block at once;
//   4. a page-link block selects every block at once, while its picker's
//      search box keeps Cmd+A to itself;
//   5. a code block (a `<textarea>`): its code first, every block second.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/select-all-ladder-verify.ts [--out /tmp/select-all]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openBlankPage } from "./support/blank-page";
import { blockSelectionDriver } from "./support/block-selection";

const out = arg("out", "/tmp/select-all");
const r = report();

const rows = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll("[data-block-id]").length);

/** What the browser itself has highlighted, text controls included. */
const domSelection = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) {
      return a.value.slice(a.selectionStart ?? 0, a.selectionEnd ?? 0);
    }
    return window.getSelection()?.toString() ?? "";
  });

const focusDescription = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return "none";
    const label = a.getAttribute("aria-label");
    return `${a.tagName.toLowerCase()}${label ? `[${label}]` : ""}${a.closest("[data-block-id]") ? " in a row" : ""}`;
  });

await withBrowser(async (h) => {
  const { page } = await h.session();
  const driver = blockSelectionDriver(page, r);

  const press = async () => {
    await page.keyboard.press("ControlOrMeta+a");
    await page.waitForTimeout(400);
  };
  const clear = async () => {
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.waitForTimeout(400);
  };

  await openBlankPage(page, { settleMs: 3000 });

  // ---- 1 + 2: text blocks ------------------------------------------------
  await page.keyboard.type("alpha");
  await page.waitForTimeout(300);
  await press();
  r.eq(
    "text block, 1st press: no block selected",
    await driver.selectedCount(),
    0,
  );
  r.eq(
    "text block, 1st press: its text is selected",
    await domSelection(page),
    "alpha",
  );
  await press();
  r.eq(
    "text block, 2nd press: every block selected",
    await driver.selectedCount(),
    await rows(page),
  );
  await driver.checkSelectionOwnsFocus("text block, 2nd press");
  await clear();

  await page
    .locator('[data-block-id] [contenteditable="true"]')
    .first()
    .click();
  await page.waitForTimeout(500);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await press();
  r.eq(
    "empty text block: every block at once",
    await driver.selectedCount(),
    await rows(page),
  );
  await clear();

  // ---- 3: divider --------------------------------------------------------
  await page.locator('[data-block-id] [contenteditable="true"]').nth(1).click();
  await page.waitForTimeout(500);
  await page.keyboard.type("---", { delay: 40 });
  await page.waitForTimeout(800);
  r.note(`divider focus: ${await focusDescription(page)}`);
  await press();
  r.eq(
    "divider: every block at once",
    await driver.selectedCount(),
    await rows(page),
  );
  await snap(page, out, "divider");
  await clear();

  // ---- 4: page link ------------------------------------------------------
  // A fresh page: the slash menu opens reliably only from a clicked-into block.
  await openBlankPage(page, { settleMs: 3000 });
  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.keyboard.type("/link", { delay: 40 });
  await page.waitForTimeout(1200);
  await snap(page, out, "pagelink-menu");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  r.ok(
    "the page-link block was inserted",
    (await page.getByText("Select a page…").count()) > 0,
  );
  r.note(`page link focus: ${await focusDescription(page)}`);
  await press();
  r.eq(
    "page link: every block at once",
    await driver.selectedCount(),
    await rows(page),
  );
  await snap(page, out, "pagelink-all");
  await clear();

  // Its picker's search box is portaled out of the row: Cmd+A stays its own.
  await page.getByText("Select a page…").click();
  await page.waitForTimeout(800);
  await page.keyboard.type("qq");
  await page.waitForTimeout(300);
  r.note(`picker focus: ${await focusDescription(page)}`);
  await press();
  await press();
  r.eq(
    "page-link picker search, two presses: no block selected",
    await driver.selectedCount(),
    0,
  );
  r.eq(
    "page-link picker search: its text is selected",
    await domSelection(page),
    "qq",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // ---- 5: code block -----------------------------------------------------
  await openBlankPage(page, { settleMs: 3000 });
  await page.keyboard.type("```");
  await page.waitForTimeout(800);
  await page.locator("[data-block-id] textarea").first().click();
  await page.waitForTimeout(300);
  await page.keyboard.type("x = 1");
  await page.waitForTimeout(300);
  await press();
  r.eq(
    "code block, 1st press: no block selected",
    await driver.selectedCount(),
    0,
  );
  r.eq(
    "code block, 1st press: its code is selected",
    await domSelection(page),
    "x = 1",
  );
  await press();
  r.eq(
    "code block, 2nd press: every block selected",
    await driver.selectedCount(),
    await rows(page),
  );
  await snap(page, out, "code");

  await r.finish();
});
