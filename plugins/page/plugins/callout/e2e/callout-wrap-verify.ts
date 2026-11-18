// `/callout` is a WRAP, not a type swap.
//
// A callout is a void container, so converting a block INTO one cannot retype
// it: the origin row keeps its id, type, `data` and children and becomes the
// anchor's FIRST CHILD, while a brand-new row is minted for the anchor
// (`BlockHandle.wrapOnConvert`, resolved inside `convertTo` so no caller
// changes).
//
// Keeping the origin's id is the whole point, and it is invisible to a unit
// test: the block's content `Y.Doc`, its owner and its registered
// `BlockFocusHandle` are ALL keyed by block id, so an id churn would drop the
// caret, orphan the doc and split the undo history. What this script asserts:
//
//  1. type "wrap me" in a blank page's first block; record its `data-block-id`
//     and the caret offset;
//  2. `/callout` + Enter;
//  3. the origin block STILL carries the same `data-block-id`, its text is
//     intact, and a callout decoration appeared on a DIFFERENT (new) row;
//  4. the origin is now nested one indent deeper — it is the anchor's child;
//  5. the caret is still in the origin at the same offset, and typing continues
//     in that same block (the live editor never remounted);
//  6. the wrap is a SINGLE undo entry — the anchor row and the re-parenting are
//     one patch, so one Cmd+Z takes the whole structure back. (It is reached
//     after the slash commit's own query-strip entry, which is generic to every
//     `/` conversion, not something the wrap introduced — see step 6 in-line.)
//
// Usage: bun plugins/page/plugins/callout/e2e/callout-wrap-verify.ts [--url <deploy>] [--out /tmp/callout-wrap]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import {
  blockText,
  caretState,
  openBlankPage,
} from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/callout-wrap");

const r = report();

/** A block row's content-edge inset, in px — one BLOCK_INDENT deeper per level. */
async function contentEdge(page: Page, id: string): Promise<number> {
  return page.evaluate((blockId) => {
    const el = document.querySelector<HTMLElement>(
      `[data-block-id="${blockId}"]`,
    );
    return el ? parseFloat(getComputedStyle(el).paddingLeft) : -1;
  }, id);
}

/** The block ids of every row currently painting a callout decoration. */
async function anchorIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll(
        'button[aria-label="Callout icon and color"]',
      ),
    ]
      .map((el) => el.closest("[data-block-id]")?.getAttribute("data-block-id"))
      .filter((id): id is string => id !== null && id !== undefined),
  );
}

/** Every block id in document order. */
async function blockIdsInOrder(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id]")]
      .map((el) => el.getAttribute("data-block-id"))
      .filter((id): id is string => id !== null),
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const {
    pageUrl,
    block,
    blockId: originId,
  } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);
  console.log("origin id:", originId);

  // --- 1. compose ------------------------------------------------------------
  await page.keyboard.type("wrap me", { delay: 20 });
  // Let the doc flush (300ms) + the ~1s data.text projection land.
  await page.waitForTimeout(2500);
  await snap(page, out, "1-composed");
  r.ok(
    "compose: the origin holds 'wrap me'",
    (await blockText(block)) === "wrap me",
  );

  const idsBefore = await blockIdsInOrder(page);
  const edgeBefore = await contentEdge(page, originId);
  console.log("before:", JSON.stringify({ idsBefore, edgeBefore }));

  // --- 2. `/callout` ---------------------------------------------------------
  // Caret at offset 0: `atWordBoundary` gates the `/` trigger, and index 0 is a
  // boundary — so the block's own text survives to the other side of the wrap.
  await block.click({ position: { x: 2, y: 12 } });
  await page.waitForTimeout(400);
  const caretBefore = await caretState(block);
  console.log("caret before /callout:", JSON.stringify(caretBefore));

  await page.keyboard.type("/callout", { delay: 40 });
  await page.waitForTimeout(800);
  await snap(page, out, "2-menu-open");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2000);
  await snap(page, out, "3-wrapped");

  // --- 3. the origin kept its identity; the anchor is a NEW row ---------------
  const idsAfter = await blockIdsInOrder(page);
  const anchors = await anchorIds(page);
  console.log("after:", JSON.stringify({ idsAfter, anchors }));

  r.ok(
    "wrap: the origin block KEEPS its data-block-id",
    idsAfter.includes(originId),
    `origin=${originId} ids=${JSON.stringify(idsAfter)}`,
  );
  r.ok(
    "wrap: a callout decoration appeared",
    anchors.length === 1,
    `anchors=${JSON.stringify(anchors)}`,
  );
  r.ok(
    "wrap: the anchor is a NEW row, not the origin retyped",
    anchors.length === 1 &&
      anchors[0] !== originId &&
      !idsBefore.includes(anchors[0]!),
    `anchor=${anchors[0]} origin=${originId}`,
  );

  const originEl = page
    .locator(`[data-block-id="${originId}"] [data-block-text]`)
    .first();
  r.ok(
    "wrap: the origin is still a TEXT block holding its text",
    (await blockText(originEl)) === "wrap me",
    await blockText(originEl),
  );

  // --- 4. the origin is now the anchor's child --------------------------------
  const edgeAfter = await contentEdge(page, originId);
  const anchorEdge = anchors[0] ? await contentEdge(page, anchors[0]) : -1;
  r.ok(
    "wrap: the origin is nested one indent INSIDE the callout",
    edgeAfter > anchorEdge && anchorEdge === edgeBefore,
    `before=${edgeBefore} anchor=${anchorEdge} after=${edgeAfter}`,
  );

  // --- 5. the caret never moved ----------------------------------------------
  const caretAfter = await caretState(originEl);
  console.log("caret after wrap:", JSON.stringify(caretAfter));
  r.ok(
    "wrap: the caret stays in the ORIGIN at its offset",
    caretAfter.hasSelection === true &&
      caretAfter.collapsed === true &&
      caretAfter.insideBlock === true &&
      caretAfter.anchorOffset === caretBefore.anchorOffset,
    `before=${caretBefore.anchorOffset} after=${caretAfter.anchorOffset}`,
  );

  await page.keyboard.type("Z", { delay: 20 });
  await page.waitForTimeout(1000);
  const typed = await blockText(originEl);
  r.ok(
    "wrap: typing continues in the SAME block (the editor never remounted)",
    typed === "Zwrap me",
    typed,
  );
  const idsAfterTyping = await blockIdsInOrder(page);
  r.ok(
    "wrap: the origin id is still unchanged after typing",
    idsAfterTyping.includes(originId),
  );

  // --- 6. the wrap is ONE undo entry ------------------------------------------
  //
  // Not one Cmd+Z from here, though — and the extra press is NOT the wrap
  // splitting in two. Every slash commit is two entries by construction
  // (`block-menu-plugin.tsx`'s `handleSelect`): it first strips the `/query`
  // through a `lexicalEditor.update()`, which the block's run tracker records
  // onto the shared stack as a text entry, and only then calls
  // `convertTo`. That is generic to every `/` conversion — `/h1` behaves
  // identically — and is the same shape the gutter `+` documents ("`insertAfter`
  // + `convertTo`, i.e. two undo entries"). So the ladder back out is:
  // typing → query-strip → wrap. What this pins is that the last rung is ONE
  // press: the anchor row and the re-parenting are a single patch.
  await page.keyboard.press("Meta+z"); // undo the "Z"
  await page.waitForTimeout(1200);
  r.ok(
    "undo: the typing reverted",
    (await blockText(originEl)) === "wrap me",
    await blockText(originEl),
  );

  await page.keyboard.press("Meta+z"); // undo the query-strip
  await page.waitForTimeout(1200);
  const restoredQuery = await blockText(originEl);
  r.ok(
    "undo: the next press restores the `/callout` query, not the structure",
    restoredQuery === "/calloutwrap me",
    restoredQuery,
  );
  r.ok(
    "undo: the callout is still standing at that point (the wrap is its own entry)",
    (await anchorIds(page)).length === 1,
  );

  await page.keyboard.press("Meta+z"); // undo the WRAP — one entry, not two
  await page.waitForTimeout(1800);
  await snap(page, out, "4-undone");

  const anchorsUndone = await anchorIds(page);
  const idsUndone = await blockIdsInOrder(page);
  console.log("after undo:", JSON.stringify({ idsUndone, anchorsUndone }));
  r.ok(
    "undo: ONE further Cmd+Z removed the callout entirely",
    anchorsUndone.length === 0,
    `anchors=${JSON.stringify(anchorsUndone)}`,
  );
  r.ok(
    "undo: the origin survived under its own id",
    idsUndone.includes(originId),
    `ids=${JSON.stringify(idsUndone)}`,
  );
  r.ok(
    "undo: the row set is back to the pre-wrap state",
    idsUndone.length === idsBefore.length,
    `before=${idsBefore.length} after=${idsUndone.length}`,
  );
  r.ok(
    "undo: the origin is back at its original depth",
    (await contentEdge(page, originId)) === edgeBefore,
    `want=${edgeBefore} got=${await contentEdge(page, originId)}`,
  );
  // The strip was undone one press ago, so the faithful pre-wrap text is the one
  // that was on screen the instant before Enter committed the menu — query and all.
  r.ok(
    "undo: its text is intact",
    (await blockText(originEl)) === "/calloutwrap me",
    await blockText(originEl),
  );

  console.log("ORIGIN_ID:", originId);
  console.log("PAGE_URL:", pageUrl);
  await r.finish();
});
