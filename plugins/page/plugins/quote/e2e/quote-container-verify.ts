// A quote is a VOID container — it quotes a PASSAGE, not a line.
//
// It shipped as a text block wearing `boxClassName: "border-l-2 … italic"`, which
// could hold exactly one paragraph. This script pins the four things that fixes,
// none of which a unit test of the pure grouping can see (a frame is a
// `pointer-events-none` SIBLING backdrop spanning grid lines, never an ancestor of
// the rows — so every claim here is measured off live rects on the real surface):
//
//  1. THE VOID SCHEMA IS ENFORCED AT THE WRITE BOUNDARY. A `quote` payload
//     carrying a `text` key is REJECTED (`parseBlockData`'s top-level `.strict()`
//     ⇒ loud 400), while `{}` is accepted. That is what makes the pre-migration
//     text-bearing rows unwritable rather than merely unused, and it is checked
//     for its REASON too — an unregistered block type 400s here as well.
//  2. `/quote` WRAPS (`wrapOnConvert: true`): the origin keeps its id and its
//     `text` type and becomes the quote's first child. Keeping the id is the
//     load-bearing part — the content `Y.Doc`, its owner and the registered
//     focus handle are all keyed by block id.
//  3. ENTER YIELDS A SECOND PARAGRAPH INSIDE THE SAME BAR. Exactly one new row, a
//     child of the SAME quote, and NO second bar. This is the headline
//     regression: under the text-bearing model another line meant another quote,
//     so a two-paragraph quotation drew two bars with a seam between them. The
//     bar's own height must also GROW to cover the new row — the frame spans
//     `start..end` grid lines, which is why one unbroken rule now runs the height
//     of the passage.
//  4. THE FIRST VISIBLE LINE CAN BE A HEADING, and a LIST can live inside the
//     bar. Structurally impossible under the text-bearing model, where the quote's
//     own line was `text`-typed by construction and a Tab-ed list landed outside
//     the border.
//
// Measurement convention: a quote's box is identified by its LEFT border and
// nothing else — no tint, no top border (that is what separates it from a
// callout's fill and an annotation card's wash), and deliberately not by
// any anchor-decoration selector, which would fail on a cosmetic rename rather
// than on a regression.
//
// Usage: bun plugins/page/plugins/quote/e2e/quote-container-verify.ts [--url <deploy>] [--out /tmp/quote]
import {
  pageFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { blockText, openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/quote");

const r = report();

/** Record one failure and stop. Used where nothing further is checkable. */
async function bail(name: string, detail: string): Promise<never> {
  r.fail(name, detail);
  return await r.finish();
}

interface FrameBox {
  top: number;
  bottom: number;
  left: number;
  height: number;
}

interface RowRect {
  top: number;
  bottom: number;
  height: number;
  /** The row's content edge — one BLOCK_INDENT deeper per nesting level. */
  contentLeft: number;
  /** Does this row own an editable surface? A void anchor row must not. */
  editable: boolean;
}

interface Geometry {
  /** Every painted LEFT-RULE backdrop currently on the block grid. */
  bars: FrameBox[];
  rows: Record<string, RowRect | undefined>;
  /** Every block id in document order. */
  order: string[];
}

/**
 * Read the surface's geometry off the DOM in one pass.
 *
 * The browser side only MEASURES; every "which bar belongs to which block"
 * decision is made in the helpers below, where it stays readable.
 */
async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const rows: Record<string, RowRect> = {};
    const order: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      "[data-block-id]",
    )) {
      const id = el.getAttribute("data-block-id");
      if (id === null) continue;
      order.push(id);
      const rect = el.getBoundingClientRect();
      rows[id] = {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        contentLeft:
          rect.left + parseFloat(getComputedStyle(el).paddingLeft || "0"),
        editable: el.querySelector('[contenteditable="true"]') !== null,
      };
    }

    // Rows sit one wrapper deep in the block grid (each row wrapper is placed on
    // its own grid line); the frames are siblings of those wrappers, holding no
    // rows of their own — which is exactly how they are told apart here.
    const anyRow = document.querySelector<HTMLElement>("[data-block-id]");
    const grid = anyRow?.parentElement?.parentElement;
    const bars: FrameBox[] = [];
    for (const child of grid ? [...grid.children] : []) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.querySelector("[data-block-id]") !== null) continue;
      for (const node of [
        child,
        ...child.querySelectorAll<HTMLElement>("div"),
      ]) {
        const style = getComputedStyle(node);
        // A quote's box is a LEFT rule and nothing else: no top border, and no
        // fill (the callout's tint, and every annotation card's wash — since the
        // redesign those cards carry no border at all, so the rule below still
        // tells a quote apart from every one of them).
        const leftOnly =
          parseFloat(style.borderLeftWidth || "0") > 0 &&
          style.borderLeftStyle !== "none" &&
          parseFloat(style.borderTopWidth || "0") === 0;
        if (!leftOnly) continue;
        const box = node.getBoundingClientRect();
        bars.push({
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          height: box.height,
        });
        break;
      }
    }
    return { bars, rows, order };
  });
}

/**
 * The bar a given block OWNS — the one whose top edge sits on that block's row.
 *
 * Geometry rather than DOM position, and the TOP EDGE rather than containment:
 * containment is ambiguous once containers nest, while a frame always starts at
 * its container's own grid line.
 */
function barOwnedBy(g: Geometry, blockId: string): FrameBox | undefined {
  const row = g.rows[blockId];
  if (!row) return undefined;
  return g.bars.find((b) => Math.abs(b.top - row.top) <= 1);
}

/** The earliest row in document order whose top sits on this bar's top edge. */
function ownerOf(g: Geometry, bar: FrameBox): string | undefined {
  return g.order.find((id) => {
    const row = g.rows[id];
    return row != null && Math.abs(row.top - bar.top) <= 1;
  });
}

/**
 * The block ids of every row currently OWNING a bar.
 *
 * A SET, not a count: `pruneEmptyAnchors` is a forest-wide post-pass, so any
 * structural op may legitimately remove a childless quote elsewhere on the page.
 * "Enter did not mint a second quote" is therefore "no NEW id appeared".
 */
function barOwners(g: Geometry): string[] {
  return g.bars
    .map((b) => ownerOf(g, b))
    .filter((id): id is string => id !== undefined);
}

/** The topmost VISIBLE line (non-zero-height row) painted inside a bar. */
function firstLineInside(g: Geometry, bar: FrameBox): string | undefined {
  return g.order.find((id) => {
    const row = g.rows[id];
    return (
      row != null &&
      row.height > 1 &&
      row.top >= bar.top - 1 &&
      row.bottom <= bar.bottom + 1
    );
  });
}

interface StoredRow {
  id: string;
  parentId: string | null;
  type: string;
}

/**
 * The persisted forest, straight from the blocks endpoint.
 *
 * Rects prove what is painted; only this proves the STRUCTURE — that the wrap's
 * origin kept its id and type, and that Enter's new row is a SIBLING under the
 * same quote rather than merely rendering at that indent.
 */
async function storedRows(page: Page, pageId: string): Promise<StoredRow[]> {
  const res = await pageFetch(page, `/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`GET blocks ${res.status}: ${await res.text()}`);
  return (await res.json()) as StoredRow[];
}

/**
 * Post a `quote` payload and report the boundary's verdict verbatim, without
 * throwing — assertion #1 is about a REJECTION, so the failure path is the
 * measurement, not an error.
 */
async function postBlock(
  page: Page,
  pageId: string,
  data: unknown,
): Promise<{ status: number; body: string }> {
  const res = await pageFetch(page, "/api/blocks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentId: pageId, type: "quote", data }),
  });
  return { status: res.status, body: (await res.text()).slice(0, 400) };
}

/** Commit a slash-menu conversion from the end of a block's text. */
async function convertVia(
  page: Page,
  blockId: string,
  query: string,
): Promise<void> {
  await page
    .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
    .first()
    .click();
  await page.keyboard.press("End");
  await page.keyboard.type(` ${query}`, { delay: 25 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const doc = await openBlankPage(page, { settleMs: 3000 });
  const originId = doc.blockId;
  console.log("page url:", doc.pageUrl);

  // --- 1. the void schema is enforced at the write boundary -------------------
  const rejected = await postBlock(page, doc.pageId, {
    text: [{ text: "wisdom" }],
  });
  r.eq("a text-bearing quote payload is rejected", rejected.status, 400);
  r.ok(
    "…and rejected for the RIGHT reason (unrecognized key `text`, not unknown type)",
    /text/i.test(rejected.body) && !/unknown block type/i.test(rejected.body),
    rejected.body,
  );
  const accepted = await postBlock(page, doc.pageId, {});
  r.ok(
    "a void `{}` quote payload is accepted",
    accepted.status < 400,
    String(accepted.status),
  );

  // --- 2. `/quote` WRAPS ------------------------------------------------------
  await page
    .locator(`[data-block-id="${originId}"] [contenteditable="true"]`)
    .first()
    .click();
  await page.keyboard.type("The best way to predict the future", { delay: 15 });
  await page.waitForTimeout(600);
  await convertVia(page, originId, "/quote");
  await snap(page, out, "wrapped");

  let g = await geometry(page);
  const originRow = g.rows[originId];
  if (!originRow)
    return await bail("the origin survived the wrap", `no row for ${originId}`);
  r.ok(
    "the origin block kept its id",
    originRow.editable,
    JSON.stringify(originRow),
  );
  r.eq(
    "the origin's text is intact",
    await blockText(
      page
        .locator(`[data-block-id="${originId}"] [contenteditable="true"]`)
        .first(),
    ),
    "The best way to predict the future",
  );

  let rows = await storedRows(page, doc.pageId);
  const origin = rows.find((b) => b.id === originId);
  r.eq(
    "the origin is still a `text` block — a wrap, not a retype",
    origin?.type,
    "text",
  );
  const quoteId = origin?.parentId ?? "";
  r.eq(
    "…whose parent is a freshly minted `quote` anchor",
    rows.find((b) => b.id === quoteId)?.type,
    "quote",
  );

  const bar = barOwnedBy(g, quoteId);
  if (!bar)
    return await bail("the quote paints a left bar", JSON.stringify(g.bars));
  r.ok(
    "the anchor row itself renders NO line (zero height, no contenteditable)",
    (g.rows[quoteId]?.height ?? 99) <= 1 && g.rows[quoteId]?.editable === false,
    JSON.stringify(g.rows[quoteId]),
  );
  r.ok(
    "the origin is nested one indent inside the bar",
    originRow.contentLeft > (g.rows[quoteId]?.contentLeft ?? 0),
    `quote=${g.rows[quoteId]?.contentLeft} origin=${originRow.contentLeft}`,
  );

  // --- 3. Enter yields a SECOND PARAGRAPH inside the SAME bar ------------------
  const ownersBefore = barOwners(g);
  const heightBefore = bar.height;
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("is to invent it.", { delay: 15 });
  await page.waitForTimeout(1500);
  await snap(page, out, "two-paragraphs");

  g = await geometry(page);
  rows = await storedRows(page, doc.pageId);
  const siblings = rows.filter((b) => b.parentId === quoteId);
  r.eq("Enter added exactly one row, inside the quote", siblings.length, 2);
  r.ok(
    "…and no SECOND bar was minted",
    barOwners(g).every((id) => ownersBefore.includes(id)),
    `before=${ownersBefore.join(",")} after=${barOwners(g).join(",")}`,
  );
  const grown = barOwnedBy(g, quoteId);
  r.ok(
    "…and the ONE bar grew to span the whole passage",
    (grown?.height ?? 0) > heightBefore,
    `before=${heightBefore} after=${grown?.height}`,
  );

  // --- 4. a heading first, and a list, both inside the bar ---------------------
  await convertVia(page, originId, "/h1");
  await page.waitForTimeout(800);
  const second = siblings.find((b) => b.id !== originId)?.id ?? "";
  if (second) await convertVia(page, second, "/bulleted");
  await page.waitForTimeout(800);
  await snap(page, out, "heading-and-list");

  g = await geometry(page);
  rows = await storedRows(page, doc.pageId);
  r.eq(
    "the quote's first child is a heading",
    rows.find((b) => b.id === originId)?.type,
    "heading-1",
  );
  r.eq(
    "…and its second is a bulleted list — both inside the bar",
    rows.find((b) => b.id === second)?.type,
    "bulleted-list",
  );
  const finalBar = barOwnedBy(g, quoteId);
  r.eq(
    "the topmost VISIBLE line inside the bar is that heading",
    finalBar ? firstLineInside(g, finalBar) : undefined,
    originId,
  );

  await r.finish();
});
