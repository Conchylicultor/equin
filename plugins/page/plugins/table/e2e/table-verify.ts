// The table block in a real browser: a pasted GFM table becomes ONE table block
// rendering a real <table>, its source mode edits it as markdown (an invalid
// source is refused and writes nothing), and the commit is one undo step.
//
// Phases:
//   1. pasting a GFM table into an empty block renders a <table> with the
//      pasted header and body cells (and no raw-pipe paragraph);
//   2. "Edit source" opens the table's GFM in a textarea;
//   3. an invalid source stays open with an error, the table unchanged;
//   4. a valid edit commits on mod+Enter and the table shows it;
//   5. ⌘Z restores the previous cells, ⌘⇧Z re-applies the edit.
//
// Usage: ./equin run plugins/page/plugins/table/e2e/table-verify.ts [--url <deploy>]
import type { Page } from "playwright";
import {
  ELEMENT_TIMEOUT_MS,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/table-verify");
const r = report();

const GFM = [
  "| Fruit | Qty |",
  "| --- | --: |",
  "| apple | 3 |",
  "| pear | 5 |",
].join("\n");

/** Every row of the page's first table, as trimmed cell texts (header first). */
function tableCells(page: Page): Promise<string[][]> {
  return page
    .locator("[data-block-id] table")
    .first()
    .evaluate((table) =>
      [...table.querySelectorAll("tr")].map((tr) =>
        [...tr.querySelectorAll("th, td")].map((c) =>
          (c.textContent ?? "").trim(),
        ),
      ),
    );
}

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await openBlankPage(page, { settleMs: 3000 });

  // ---- 1: paste a GFM table -------------------------------------------------
  await page.evaluate((text) => navigator.clipboard.writeText(text), GFM);
  await page.keyboard.press("Meta+v");
  const table = page.locator("[data-block-id] table").first();
  await table.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  r.eq("1a: the pasted table renders its cells", await tableCells(page), [
    ["Fruit", "Qty"],
    ["apple", "3"],
    ["pear", "5"],
  ]);
  const rawPipes = await page.evaluate(() =>
    [
      ...document.querySelectorAll('[data-block-id] [contenteditable="true"]'),
    ].some((el) => (el.textContent ?? "").includes("|")),
  );
  r.ok("1b: no paragraph holds raw pipes", !rawPipes);
  r.eq(
    "1c: the right-aligned column is right-aligned",
    await table
      .locator("td")
      .nth(1)
      .evaluate((td) => getComputedStyle(td).textAlign),
    "right",
  );
  await snap(page, out, "pasted");

  // ---- 2: open the source -----------------------------------------------------
  await table.hover();
  await page.getByRole("button", { name: "Edit source" }).first().click();
  const source = page.getByRole("textbox", { name: "Table source" });
  await source.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  const original = await source.inputValue();
  r.ok(
    "2: the source is the table's GFM",
    original.includes("| Fruit | Qty |") && original.includes("| pear | 5 |"),
  );

  // ---- 3: an invalid source is refused ----------------------------------------
  await source.fill("not a table");
  await page.keyboard.press("Escape");
  await page
    .getByRole("alert")
    .first()
    .waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  r.ok("3a: an invalid source stays open", await source.isVisible());
  await snap(page, out, "invalid");

  // ---- 4: a valid edit commits --------------------------------------------------
  await source.fill(original.replace("| pear | 5 |", "| plum | 7 |"));
  await page.keyboard.press("Meta+Enter");
  await source.waitFor({ state: "detached", timeout: ELEMENT_TIMEOUT_MS });
  r.eq("4: the committed edit renders", await tableCells(page), [
    ["Fruit", "Qty"],
    ["apple", "3"],
    ["plum", "7"],
  ]);
  await snap(page, out, "edited");

  // ---- 5: one undo step --------------------------------------------------------
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  r.eq("5a: ⌘Z restores the previous cells", await tableCells(page), [
    ["Fruit", "Qty"],
    ["apple", "3"],
    ["pear", "5"],
  ]);
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(300);
  r.eq("5b: ⌘⇧Z re-applies the edit", await tableCells(page), [
    ["Fruit", "Qty"],
    ["apple", "3"],
    ["plum", "7"],
  ]);
});

await r.finish();
