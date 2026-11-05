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
//   5. ⌘Z restores the previous cells, ⌘⇧Z re-applies the edit;
//   6. the cells' text selects natively: a drag across cells selects their words
//      (the surface is otherwise user-select: none), and a drag that leaves the
//      table for the line above becomes a block range, never a native selection
//      running across the page;
//   7. the caret cue is painted on the table's widened box, not on the
//      column-wide host around it.
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
  // A line above the table, for phase 6's drag out of it.
  await page.keyboard.type("above");
  await page.keyboard.press("Enter");

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

  // ---- 6: the cells' text is selectable ---------------------------------------
  const cellBox = async (text: string) => {
    const box = await table.getByText(text, { exact: true }).boundingBox();
    if (!box) throw new Error(`cell "${text}" has no box`);
    return box;
  };
  const from = await cellBox("apple");
  const to = await cellBox("7");
  await page.mouse.move(from.x + 1, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 1, to.y + to.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
  r.ok(
    `6a: a drag across cells selects their text (got ${JSON.stringify(selected)})`,
    selected.includes("apple") && selected.includes("7"),
  );
  await snap(page, out, "selected");

  const above = await page
    .getByText("above", { exact: true })
    .first()
    .boundingBox();
  if (!above) throw new Error('the "above" line has no box');
  await page.mouse.move(from.x + 1, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(above.x + 2, above.y + above.height / 2, {
    steps: 8,
  });
  const nativeOut = await page.evaluate(
    () => getSelection()?.toString() ?? "",
  );
  await page.mouse.up();
  r.eq("6b: dragging out of the table leaves no native selection", nativeOut, "");
  r.ok(
    "6c: … it selects the blocks instead",
    (await page.locator("[data-selection-band]").count()) > 0,
  );
  await page.keyboard.press("Escape");

  // ---- 7: the caret cue surrounds the widened table ---------------------------
  await table.getByText("apple", { exact: true }).click();
  await page.waitForTimeout(200);
  const cue = await table.evaluate((t) => {
    const host = t.closest("[data-caret-host]");
    const wide = t.closest(".w-max");
    const bg = (el: Element | null) =>
      el ? getComputedStyle(el).backgroundColor : "missing";
    return {
      current: host?.getAttribute("aria-current") ?? null,
      host: bg(host),
      wide: bg(wide),
    };
  });
  r.eq("7a: the caret is on the table", cue.current, "true");
  r.eq("7b: the column-wide host paints no tint", cue.host, "rgba(0, 0, 0, 0)");
  r.ok(
    `7c: the widened box carries the tint (got ${cue.wide})`,
    cue.wide !== "rgba(0, 0, 0, 0)" && cue.wide !== "missing",
  );
  await snap(page, out, "cue");
});

await r.finish();
