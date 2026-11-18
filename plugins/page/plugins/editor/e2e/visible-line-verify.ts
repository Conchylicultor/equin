// Verifies the "visible-line" Enter/Backspace invariants documented in
// plugins/page/plugins/editor/CLAUDE.md ("Visible-line invariants (Enter /
// Backspace)") end-to-end in a real browser:
//
//  A. Split-with-children adoption — splitting a block that has visible
//     children hands the children to the TAIL, not the head.
//  B. Backspace ladder on a nested bullet — marker (convertTo) -> indentation
//     (outdent) -> line break (merge), in that order.
//  C. Empty-Enter escape ladder on a nested bullet — indentation (outdent)
//     first, then the type (convertTo).
//  D. Checked to-do split (smoke) — `dataOnSplit` yields an unchecked tail.
//
// Modeled closely on ./crdt-split-merge-verify.ts (page creation, block
// locating/typing helpers, DOM-structure assertions).
//
// Usage: bun plugins/page/plugins/editor/e2e/visible-line-verify.ts [--url <deploy>] [--out /tmp/visible-line]
import {
  arg,
  pathUrl,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Locator, Page } from "playwright";
import { openBlankPage } from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const out = arg("out", "/tmp/visible-line");

const r = report();

// Poll the base URL until the backend serves (build/boot may still be finishing).
async function waitForServer(
  url: string,
  deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch (err) {
      // Connection refused / reset while the backend is still booting is exactly
      // the state this loop polls for; the deadline below is the failure path.
      void err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

const root = pathUrl("/");
console.log(`waiting for ${root} ...`);
const up = await waitForServer(root, 60_000);
r.ok("server is serving", up);
if (!up) await r.finish();

// BLOCK_GUTTER / BLOCK_INDENT from plugins/page/plugins/editor/web/internal/page-column.ts.
// Kept as local literals on purpose: the `e2e` runtime may not import `web`.
const BLOCK_GUTTER = 64;
const BLOCK_INDENT = 24;

interface RowSnapshot {
  id: string | null;
  text: string;
  depth: number;
  hasBulletMarker: boolean;
  checked: boolean | null;
}

/**
 * Flat, document-ordered snapshot of every text-bearing block row: id, visible
 * text, indent depth (derived from the row's own `paddingLeft` inline style —
 * there is no `data-depth` attribute; see block-row.tsx), whether a bullet
 * marker ("•") is currently rendered, and to-do checkbox state if any.
 */
async function getRows(page: Page): Promise<RowSnapshot[]> {
  return page.evaluate<RowSnapshot[], { gutter: number; indent: number }>(
    ({ gutter, indent }) => {
      const rows = [
        ...document.querySelectorAll<HTMLElement>("[data-block-id]"),
      ].filter((el) => el.querySelector("[data-block-text]"));
      return rows.map((el) => {
        const paddingLeft = parseFloat(el.style.paddingLeft || "0");
        const depth = Math.round((paddingLeft - gutter) / indent);
        const markerSpan = [
          ...el.querySelectorAll('span[aria-hidden="true"]'),
        ].find((s) => s.textContent === "•");
        const checkbox = el.querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        );
        const editable = el.querySelector("[data-block-text]");
        return {
          id: el.getAttribute("data-block-id"),
          text: (editable?.textContent ?? "").trim(),
          depth,
          hasBulletMarker: !!markerSpan,
          checked: checkbox ? checkbox.checked : null,
        };
      });
    },
    { gutter: BLOCK_GUTTER, indent: BLOCK_INDENT },
  );
}

function editableFor(page: Page, blockId: string | null | undefined): Locator {
  return page.locator(`[data-block-id="${blockId}"] [data-block-text]`).first();
}

/**
 * Click near an editable's left edge to approximate caret offset 0, then
 * verify+correct via ArrowLeft: a click's "nearest position" hit-test can
 * land AFTER the first character when that glyph is narrow (e.g. "i"), even
 * though the same x offset lands at true offset 0 for a wide glyph (e.g.
 * "A"/"d") — confirmed by a false failure in scenario B where Backspace ate
 * the "i" of "item" (offset 1), not the marker (offset 0).
 */
async function caretToStart(page: Page, editable: Locator): Promise<void> {
  await editable.click({ position: { x: 2, y: 12 } });
  await page.waitForTimeout(200);
  for (let guard = 0; guard < 20; guard++) {
    const offset = await page.evaluate(
      () => window.getSelection()?.anchorOffset ?? -1,
    );
    if (offset <= 0) break;
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(40);
  }
}

await withBrowser(async (h) => {
  // ===========================================================================
  // A. Split-with-children adoption
  // ===========================================================================
  console.log("\n=== Scenario A: split-with-children adoption ===");
  {
    const { context, page } = await h.session();
    const { block: first, blockId: firstId } = await openBlankPage(page, {
      settleMs: 3000,
    });

    await first.click();
    await typeLines(page, ["AAACCC", "BBB"]);
    // The Tab is hand-rolled, NOT folded into the typeLines call as an `indent`
    // line: that would press it against an EMPTY block, and indenting an empty
    // block is a different input (different caret context, so different
    // `resolveKeystroke` inputs) than indenting one that already holds text.
    // Dropping a settle must never change the gesture under test.
    await page.keyboard.press("Tab"); // indent BBB under AAACCC
    // Structural indent op — `depth` is read off the rendered row, so wait for
    // its rows, not for anything about typing.
    await page.waitForTimeout(800);

    const beforeSplit = await getRows(page);
    console.log("before split:", JSON.stringify(beforeSplit));
    r.ok(
      "A: setup — two rows (AAACCC, BBB@depth1)",
      beforeSplit.length === 2,
      `count=${beforeSplit.length}`,
    );
    r.ok(
      "A: setup — BBB indented under AAACCC",
      beforeSplit[1]?.depth === 1,
      `depth=${beforeSplit[1]?.depth}`,
    );

    // Caret to start of AAACCC, then 3x ArrowRight -> between "AAA" and "CCC".
    // The per-arrow pause is the selectionchange lag Lexical absorbs caret moves
    // through (same caveat as crdt-split-merge-verify), not a typing settle.
    const head = editableFor(page, firstId);
    await caretToStart(page, head);
    await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);
    await snap(page, `${out}/a`, "split-with-children");

    const afterSplit = await getRows(page);
    console.log("after split:", JSON.stringify(afterSplit));
    r.ok(
      "A: three rows after split",
      afterSplit.length === 3,
      `count=${afterSplit.length}`,
    );
    if (afterSplit.length === 3) {
      r.ok(
        "A: row0 = AAA @ depth0",
        afterSplit[0]?.text === "AAA" && afterSplit[0]?.depth === 0,
        JSON.stringify(afterSplit[0]),
      );
      r.ok(
        "A: row1 = CCC @ depth0 (immediately after AAA, not indented)",
        afterSplit[1]?.text === "CCC" && afterSplit[1]?.depth === 0,
        JSON.stringify(afterSplit[1]),
      );
      r.ok(
        "A: row2 = BBB @ depth1 (now nested under CCC, by document order)",
        afterSplit[2]?.text === "BBB" && afterSplit[2]?.depth === 1,
        JSON.stringify(afterSplit[2]),
      );
    }

    await context.close();
  }

  // ===========================================================================
  // B. Backspace ladder on a nested bullet
  // ===========================================================================
  console.log(
    "\n=== Scenario B: Backspace ladder (marker -> outdent -> merge) ===",
  );
  {
    const { context, page } = await h.session();
    const { block: first } = await openBlankPage(page, {
      settleMs: 3000,
    });
    await first.click();
    // "* " is the markdown prefix that converts the block to a bulleted-list.
    await typeLines(page, ["parent", { text: "* item", indent: "in" }]);
    // Structural indent op + the convertTo the prefix triggers — both are read
    // back as `depth` / `hasBulletMarker`, so let their rows land.
    await page.waitForTimeout(1000);

    let rows = await getRows(page);
    console.log("B setup:", JSON.stringify(rows));
    r.ok("B: setup — two rows", rows.length === 2, `count=${rows.length}`);
    r.ok(
      "B: setup — item is a bullet",
      rows[1]?.hasBulletMarker === true,
      JSON.stringify(rows[1]),
    );
    r.ok(
      "B: setup — item is indented (depth1)",
      rows[1]?.depth === 1,
      `depth=${rows[1]?.depth}`,
    );
    r.ok(
      "B: setup — item text is 'item'",
      rows[1]?.text === "item",
      rows[1]?.text,
    );
    const itemDepthBefore = rows[1]?.depth;

    const itemId = rows[1]?.id;
    const itemEditable = editableFor(page, itemId);
    await caretToStart(page, itemEditable);
    await page.waitForTimeout(300);

    // --- Backspace #1: marker gone, still indented ---
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(700);
    await snap(page, `${out}/b`, "1-marker-gone");
    rows = await getRows(page);
    console.log("B after backspace 1:", JSON.stringify(rows));
    r.ok("B1: still two rows", rows.length === 2, `count=${rows.length}`);
    r.ok(
      "B1: bullet marker is GONE",
      rows[1]?.hasBulletMarker === false,
      JSON.stringify(rows[1]),
    );
    r.ok(
      "B1: still indented (unchanged depth)",
      rows[1]?.depth === itemDepthBefore,
      `depth=${rows[1]?.depth}`,
    );
    r.ok("B1: text still 'item'", rows[1]?.text === "item", rows[1]?.text);

    // --- Backspace #2: outdents to top level ---
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(700);
    await snap(page, `${out}/b`, "2-outdented");
    rows = await getRows(page);
    console.log("B after backspace 2:", JSON.stringify(rows));
    r.ok(
      "B2: still two separate rows",
      rows.length === 2,
      `count=${rows.length}`,
    );
    r.ok(
      "B2: outdented to top level (depth0)",
      rows[1]?.depth === 0,
      `depth=${rows[1]?.depth}`,
    );
    r.ok("B2: text still 'item'", rows[1]?.text === "item", rows[1]?.text);

    // --- Backspace #3: merges into previous line ---
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(900);
    await snap(page, `${out}/b`, "3-merged");
    rows = await getRows(page);
    console.log("B after backspace 3:", JSON.stringify(rows));
    r.ok("B3: merged into one row", rows.length === 1, `count=${rows.length}`);
    r.ok(
      "B3: merged text is 'parentitem' (or joins parent+item)",
      rows[0]?.text === "parentitem",
      rows[0]?.text,
    );

    await context.close();
  }

  // ===========================================================================
  // C. Empty-Enter escape ladder on a nested bullet
  // ===========================================================================
  console.log(
    "\n=== Scenario C: Empty-Enter escape ladder (outdent -> convertTo) ===",
  );
  {
    const { context, page } = await h.session();
    const { block: first } = await openBlankPage(page, {
      settleMs: 3000,
    });
    await first.click();
    // "* " converts to a bulleted-list and leaves the block EMPTY — the state the
    // empty-Enter ladder acts on.
    await typeLines(page, ["parent", { text: "* ", indent: "in" }]);
    // Structural indent op + the convertTo the prefix triggers — both are read
    // back as `depth` / `hasBulletMarker`, so let their rows land.
    await page.waitForTimeout(1000);

    let rows = await getRows(page);
    console.log("C setup:", JSON.stringify(rows));
    r.ok("C: setup — two rows", rows.length === 2, `count=${rows.length}`);
    r.ok(
      "C: setup — empty bullet, indented",
      rows[1]?.hasBulletMarker === true && rows[1]?.depth === 1,
      JSON.stringify(rows[1]),
    );
    r.ok(
      "C: setup — text is empty",
      rows[1]?.text === "",
      JSON.stringify(rows[1]?.text),
    );

    const emptyId = rows[1]?.id;
    const emptyEditable = editableFor(page, emptyId);
    await emptyEditable.click();
    await page.waitForTimeout(300);

    // --- Enter #1 (empty, depth1): outdent, keep bullet type ---
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    await snap(page, `${out}/c`, "1-outdented");
    rows = await getRows(page);
    console.log("C after enter 1:", JSON.stringify(rows));
    r.ok(
      "C1: still two rows (no split)",
      rows.length === 2,
      `count=${rows.length}`,
    );
    r.ok(
      "C1: outdented to top level",
      rows[1]?.depth === 0,
      `depth=${rows[1]?.depth}`,
    );
    r.ok(
      "C1: still a bullet",
      rows[1]?.hasBulletMarker === true,
      JSON.stringify(rows[1]),
    );

    // --- Enter #2 (empty, depth0): convert to plain text, marker gone ---
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    await snap(page, `${out}/c`, "2-converted");
    rows = await getRows(page);
    console.log("C after enter 2:", JSON.stringify(rows));
    r.ok(
      "C2: still two rows (no split)",
      rows.length === 2,
      `count=${rows.length}`,
    );
    r.ok(
      "C2: bullet marker GONE (converted to text)",
      rows[1]?.hasBulletMarker === false,
      JSON.stringify(rows[1]),
    );
    r.ok(
      "C2: stayed at top level",
      rows[1]?.depth === 0,
      `depth=${rows[1]?.depth}`,
    );

    await context.close();
  }

  // ===========================================================================
  // D. Checked to-do split (smoke)
  // ===========================================================================
  console.log("\n=== Scenario D: checked to-do split -> unchecked tail ===");
  {
    const { context, page } = await h.session();
    const { block: first, blockId: firstId } = await openBlankPage(page, {
      settleMs: 3000,
    });
    await first.click();
    await page.keyboard.type("[] done it", { delay: 20 }); // "[] " markdown prefix -> to-do
    await page.waitForTimeout(600); // the prefix's convertTo op, read back as `checked`

    let rows = await getRows(page);
    console.log("D setup:", JSON.stringify(rows));
    r.ok(
      "D: setup — one to-do row, unchecked",
      rows.length === 1 && rows[0]?.checked === false,
      JSON.stringify(rows),
    );
    r.ok(
      "D: setup — text is 'done it'",
      rows[0]?.text === "done it",
      rows[0]?.text,
    );

    // Check the checkbox.
    const checkbox = page
      .locator(`[data-block-id="${firstId}"] input[type="checkbox"]`)
      .first();
    await checkbox.click();
    await page.waitForTimeout(500);
    rows = await getRows(page);
    r.ok(
      "D: checkbox is now checked",
      rows[0]?.checked === true,
      JSON.stringify(rows[0]),
    );
    await snap(page, `${out}/d`, "1-checked");

    // Caret mid-text ("done| it") -> after "done" (4 chars) from the start. The
    // per-arrow pause is the selectionchange lag, as in scenario A.
    const editable = editableFor(page, firstId);
    await caretToStart(page, editable);
    await page.waitForTimeout(300);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    await snap(page, `${out}/d`, "2-split");

    rows = await getRows(page);
    console.log("D after split:", JSON.stringify(rows));
    r.ok(
      "D: two to-do rows after split",
      rows.length === 2,
      `count=${rows.length}`,
    );
    r.ok("D: head text 'done'", rows[0]?.text === "done", rows[0]?.text);
    r.ok(
      "D: tail text ' it' / 'it'",
      (rows[1]?.text ?? "").trim() === "it",
      JSON.stringify(rows[1]?.text),
    );
    r.ok(
      "D: head STAYS checked",
      rows[0]?.checked === true,
      JSON.stringify(rows[0]),
    );
    r.ok(
      "D: tail is UNCHECKED",
      rows[1]?.checked === false,
      JSON.stringify(rows[1]),
    );

    await context.close();
  }

  console.log("\n=== SUMMARY ===");
  await r.finish();
});
