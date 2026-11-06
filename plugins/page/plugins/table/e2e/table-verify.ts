// The table block in a real browser: a pasted GFM table becomes ONE table block
// rendering a real <table>, edited in place — click a cell and type, Tab between
// cells, one undo step per cell, the grips' menus.
//
// Phases:
//   1. pasting a GFM table into an empty block renders a <table> with the
//      pasted header and body cells (and no raw-pipe paragraph);
//   2. a click opens the cell in place; Tab writes it and opens the next;
//      Escape writes and leaves, the cell selected;
//   3. ⌘Z undoes the last cell's write, ⌘⇧Z re-applies it;
//   4. Tab out of the last cell appends a row;
//   5. the row grip's menu deletes a row, the column grip's duplicates a
//      column (and ⌘Z undoes it);
//   6. selecting cells: a drag across cells selects the rectangle (no native
//      text selection), ⌘C copies it as tab-separated text, Backspace clears it
//      (one undo step), a spreadsheet grid pasted into an open cell spreads
//      across the table and grows it, Escape in a cell selects it and
//      Shift+→ grows the selection, typing over a selected cell replaces its
//      text — and a drag that leaves the table for the line above becomes a
//      block range, never a native selection running across the page;
//   7. the caret cue is painted on the table's widened box, not on the
//      column-wide host around it;
//   8. a table WIDER than the column, block-selected, gets a selection band
//      covering its whole widened box (not just the column under it), and a
//      run of "above" + the table is two touching bands: the column-wide one
//      above, the widened one under it.
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

  // ---- 2: click a cell and type ----------------------------------------------
  const editing = page.locator(
    "[data-block-id] table [contenteditable='true']",
  );
  await table.getByText("pear", { exact: true }).click();
  await editing.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  r.eq(
    "2a: the clicked cell opens in place",
    await editing.getAttribute("aria-label"),
    "Row 2, column 1",
  );
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("plum");
  // Tab writes the cell and opens the next one.
  await page.keyboard.press("Tab");
  await page.waitForTimeout(600);
  r.eq(
    "2b: Tab moves to the next cell",
    await editing.getAttribute("aria-label"),
    "Row 2, column 2",
  );
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("7");
  // Escape writes it and leaves the cell, the cell selected.
  await page.keyboard.press("Escape");
  await editing.waitFor({ state: "detached", timeout: ELEMENT_TIMEOUT_MS });
  r.eq("2c: the edited cells render", await tableCells(page), [
    ["Fruit", "Qty"],
    ["apple", "3"],
    ["plum", "7"],
  ]);
  await snap(page, out, "edited");

  // ---- 3: one undo step per cell ---------------------------------------------
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  r.eq("3a: ⌘Z undoes the last cell", await tableCells(page), [
    ["Fruit", "Qty"],
    ["apple", "3"],
    ["plum", "5"],
  ]);
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(300);
  r.eq("3b: ⌘⇧Z re-applies it", (await tableCells(page))[2], ["plum", "7"]);

  // ---- 4: Tab out of the last cell appends a row ----------------------------
  await table.getByText("7", { exact: true }).click();
  await editing.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.keyboard.press("Tab");
  await page.keyboard.type("fig");
  await page.keyboard.press("Escape");
  await editing.waitFor({ state: "detached", timeout: ELEMENT_TIMEOUT_MS });
  r.eq("4: a new row holds what was typed", (await tableCells(page))[3], [
    "fig",
    "",
  ]);

  // ---- 5: the row grip's menu deletes the row --------------------------------
  await table.getByText("fig", { exact: true }).hover();
  await page.getByRole("button", { name: /^Row 3 — drag to move/ }).click();
  await page
    .getByLabel("Row actions")
    .getByRole("button", { name: "Delete row" })
    .click();
  await page.waitForTimeout(300);
  r.eq("5a: the row is gone", (await tableCells(page)).length, 3);
  await table.getByText("Qty", { exact: true }).hover();
  await page.getByRole("button", { name: /^Column 2 — drag to move/ }).click();
  await page
    .getByLabel("Column actions")
    .getByRole("button", { name: "Duplicate" })
    .click();
  await page.waitForTimeout(300);
  r.eq("5b: the column is duplicated", (await tableCells(page))[0], [
    "Fruit",
    "Qty",
    "Qty",
  ]);
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  r.eq("5c: ⌘Z undoes it", (await tableCells(page))[0], ["Fruit", "Qty"]);
  await snap(page, out, "menus");

  // ---- 6: selecting cells ------------------------------------------------------
  // The caret on the line above first: a drag inside a block-SELECTED table
  // would be a block gesture.
  await page.getByText("above", { exact: true }).first().click();
  await page.waitForTimeout(200);
  const rangeBox = page.locator("[data-block-id] [data-cell-range]");
  const cellBox = async (text: string) => {
    const box = await table.getByText(text, { exact: true }).boundingBox();
    if (!box) throw new Error(`cell "${text}" has no box`);
    return box;
  };
  const from = await cellBox("apple");
  const to = await cellBox("7");
  // Inside the cells: their borders carry the chrome (the row grip on the
  // table's left edge, a resize handle on each column's right one).
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 10, to.y + to.height / 2, {
    steps: 8,
  });
  await page.mouse.up();
  const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
  r.eq("6a: a drag across cells leaves no native selection", selected, "");
  r.eq("6b: … it selects the cells", await rangeBox.count(), 1);
  await snap(page, out, "selected");
  await page.keyboard.press("Meta+c");
  r.eq(
    "6c: ⌘C copies the cells as tab-separated text",
    await page.evaluate(() => navigator.clipboard.readText()),
    "apple\t3\nplum\t7",
  );
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  r.eq("6d: Backspace clears the selected cells", await tableCells(page), [
    ["Fruit", "Qty"],
    ["", ""],
    ["", ""],
  ]);
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  r.eq("6e: ⌘Z restores them in one step", (await tableCells(page))[2], [
    "plum",
    "7",
  ]);

  await page.evaluate(() =>
    navigator.clipboard.writeText("x\ty\tz\r\nw\tv\tu\r\n"),
  );
  await table.getByText("apple", { exact: true }).click();
  await editing.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(300);
  r.eq("6f: a pasted grid spreads from the open cell", await tableCells(page), [
    ["Fruit", "Qty", ""],
    ["x", "y", "z"],
    ["w", "v", "u"],
  ]);
  r.eq("6g: … and selects what it covers", await rangeBox.count(), 1);
  await snap(page, out, "pasted-grid");
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  r.eq("6h: ⌘Z undoes the paste in one step", await tableCells(page), [
    ["Fruit", "Qty"],
    ["apple", "3"],
    ["plum", "7"],
  ]);

  await table.getByText("apple", { exact: true }).click();
  await editing.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.keyboard.press("Escape");
  await editing.waitFor({ state: "detached", timeout: ELEMENT_TIMEOUT_MS });
  r.eq("6i: Escape in a cell selects it", await rangeBox.count(), 1);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Meta+c");
  r.eq(
    "6j: Shift+→ grows the selection",
    await page.evaluate(() => navigator.clipboard.readText()),
    "apple\t3",
  );
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("kiwi", { delay: 50 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  r.eq(
    "6k: typing over a selected cell replaces it",
    (await tableCells(page))[1],
    ["kiwi", "3"],
  );
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(300);
  r.eq("6l: ⌘Z restores it", (await tableCells(page))[1], ["apple", "3"]);
  await page.getByText("above", { exact: true }).first().click();
  await page.waitForTimeout(200);

  const above = await page
    .getByText("above", { exact: true })
    .first()
    .boundingBox();
  if (!above) throw new Error('the "above" line has no box');
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(above.x + 2, above.y + above.height / 2, {
    steps: 8,
  });
  const nativeOut = await page.evaluate(() => getSelection()?.toString() ?? "");
  await page.mouse.up();
  r.eq(
    "6m: dragging out of the table leaves no native selection",
    nativeOut,
    "",
  );
  r.ok(
    "6n: … it selects the blocks instead",
    (await page.locator("[data-selection-band]").count()) > 0,
  );
  await page.keyboard.press("Escape");

  // ---- 7: the caret cue surrounds the widened table ---------------------------
  // Escape twice: the cell selected, then the table.
  await table.getByText("apple", { exact: true }).click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
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

  // ---- 8: the selection band surrounds a widened table ------------------------
  const longCell = "a very long cell that keeps going ".repeat(4).trim();
  await table.getByText("plum", { exact: true }).click();
  await editing.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.keyboard.press("Meta+a");
  await page.keyboard.type(longCell);
  await page.keyboard.press("Escape");
  await editing.waitFor({ state: "detached", timeout: ELEMENT_TIMEOUT_MS });

  // Escape twice out of the cell leaves the table block-selected.
  await table.getByText("apple", { exact: true }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  const band = page.locator("[data-selection-band]");
  await band.first().waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  await page.waitForTimeout(200);
  type Rect = { left: number; right: number; top: number; bottom: number };
  const geometry = () =>
    page.evaluate(() => {
      const rect = (el: Element | null) => {
        if (!el) throw new Error("missing element");
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      };
      const t = document.querySelector("[data-block-id] table");
      const wide = t?.closest(".w-max") ?? null;
      const host = t?.closest("[data-caret-host]") ?? null;
      const bands = [
        ...document.querySelectorAll("[data-selection-band] > *"),
      ].map(rect);
      return { wide: rect(wide), host: rect(host), bands };
    });
  const one = await geometry();
  r.ok(
    `8a: the table is wider than the column (box ${Math.round(one.wide.right - one.wide.left)}px, column ${Math.round(one.host.right - one.host.left)}px)`,
    one.wide.right - one.wide.left > one.host.right - one.host.left + 20,
  );
  r.eq("8b: one band for the selected table", one.bands.length, 1);
  const covers = (b: Rect, w: Rect) =>
    b.left <= w.left + 2 && b.right >= w.right - 2;
  r.ok(
    `8c: the band covers the widened table horizontally (band ${JSON.stringify(one.bands[0])}, table ${JSON.stringify(one.wide)})`,
    one.bands[0] !== undefined && covers(one.bands[0], one.wide),
  );
  await snap(page, out, "wide-selected");

  await page.keyboard.press("Shift+ArrowUp");
  await page.waitForTimeout(200);
  const two = await geometry();
  r.eq("8d: above + table is two bands", two.bands.length, 2);
  const [top, bottom] = two.bands;
  r.ok(
    `8e: the table's band still covers it (band ${JSON.stringify(bottom)})`,
    bottom !== undefined && covers(bottom, two.wide),
  );
  r.ok(
    `8f: the line above keeps the column band, touching the table's (above ${JSON.stringify(top)})`,
    top !== undefined &&
      bottom !== undefined &&
      top.left > bottom.left &&
      top.right < bottom.right &&
      Math.abs(top.bottom - bottom.top) <= 1,
  );
  await snap(page, out, "wide-run");
  await page.keyboard.press("Escape");
});

await r.finish();
