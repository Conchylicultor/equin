// SELECTING A CONTAINER: covering its lines is how you point at the box.
//
// A void container renders no line of its own — its content IS its children —
// so there is nothing for a pointer to click. Its row is zero height while the
// children are visible, it carries no rail and no Shift+click target, and the
// editor's `rowAtPointer` skips it by an explicit height guard. Every pointer
// gesture therefore reaches the lines INSIDE the box and never the box.
//
// The rule that closes the hole (`withContainersSelected`, `page/editor`):
//
//   > A selection covering every line a container owns IS a selection of the
//   > container.
//
// The reported defect it fixes: "copy-pasting a /todo or /context block pastes
// only the inner content — the outer box disappears". Selecting the card's lines
// resolved to the CHILDREN, so the clipboard carried three paragraphs and the
// frame was never on it. The same hole let a drag carry the children out of a
// box the user thought they were moving.
//
// A sibling of `container-rail-verify.ts` (which control acts on which block)
// and of `container-collapse-verify.ts` (the fold). This one is about the
// SELECTION: what a range covering the box's lines resolves to.
//
//  1. A PARTLY COVERED BOX IS NOT SELECTED. Two of the card's three lines
//     highlight two lines. Asserted FIRST, because it is what keeps 2 and 3 from
//     passing for the trivial reason "an anchor is always swept in".
//  2. COVERING EVERY LINE SELECTS THE BOX. The highlight jumps to FOUR lines —
//     the container's zero-height anchor row plus its three children, i.e. the
//     frame's whole span — because the band paints a selected container over its
//     frame. That is the rule, visible.
//  3. COPY THEN PASTE ROUND-TRIPS A REAL CONTAINER. A second callout row appears
//     with three text children of its own. Asserted structurally against the
//     SERVER's rows (`parentId` / `type`), not against pixels: "the box came
//     with it" is a claim about the forest, and reading it back proves the paste
//     persisted rather than merely painted.
//
// The container under test is `callout`; the behaviour belongs to the container
// primitive and to the editor's selection, so `/todo` and `/context` inherit it
// unchanged.
//
// Usage: bun plugins/page/plugins/container/e2e/container-selection-verify.ts [--url <deploy>] [--out /tmp/container-selection]
import {
  pageFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import {
  blockSelectionDriver,
  highlightedLines,
  openBlankPage,
  pageIdFromUrl,
} from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/container-selection");
const r = report();

/** Record one failure and stop. Used where nothing further is checkable. */
async function bail(name: string, detail: string): Promise<never> {
  r.fail(name, detail);
  return await r.finish();
}

interface Row {
  id: string;
  parentId: string | null;
  type: string;
}

/**
 * A block's index among the EDITABLE rows — what `enterBlockSelection` counts.
 *
 * Never a literal index: `openBlankPage` leaves its own empty block on the page
 * and a container's ANCHOR row carries no `contenteditable` at all, so the seed's
 * first line is neither row 0 nor row 1 by any rule worth writing down. Asking
 * the DOM for the row we actually mean is the only spelling that cannot drift
 * when the blank-page flow or the anchor's rendering changes.
 */
async function editableIndexOf(page: Page, blockId: string): Promise<number> {
  const index = await page.evaluate(
    (id: string) =>
      [
        ...document.querySelectorAll(
          '[data-block-id] [contenteditable="true"]',
        ),
      ].findIndex(
        (el) =>
          el.closest("[data-block-id]")?.getAttribute("data-block-id") === id,
      ),
    blockId,
  );
  if (index < 0)
    return await bail(
      `editable row for ${blockId}`,
      "no editable row with that id",
    );
  return index;
}

/**
 * The page's rows as the SERVER holds them.
 *
 * Structure, not pixels: "the pasted copy is a container with the same children"
 * is a claim about `type` and `parentId`, and reading it back is what makes the
 * assertion immune to how the frame happens to be painted — and what proves the
 * paste was persisted rather than merely rendered.
 */
async function rows(page: Page, pageId: string): Promise<Row[]> {
  const res = await pageFetch(page, `/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`GET blocks ${res.status}: ${await res.text()}`);
  return (await res.json()) as Row[];
}

await withBrowser(async (h) => {
  const { context, page } = await h.session({ label: "A" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { checkSelectionOwnsFocus, enterBlockSelection } = blockSelectionDriver(
    page,
    r,
  );

  const doc = await openBlankPage(page, { settleMs: 800 });
  const pageId = pageIdFromUrl(doc.pageUrl);

  // A callout with THREE children — enough that "two of them" is a genuinely
  // partial cover — plus one block after the box, which is what a paste landing
  // OUTSIDE the card can be told apart against.
  const seeded = await (async () => {
    const post = async (body: unknown) => {
      const res = await pageFetch(page, "/api/blocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`POST /api/blocks ${res.status}: ${await res.text()}`);
      return (await res.json()) as { id: string };
    };
    const box = await post({
      parentId: pageId,
      type: "callout",
      data: { icon: null, color: "info" },
    });
    const text = (parentId: string, body: string) =>
      post({ parentId, type: "text", data: { text: [{ text: body }] } });
    const first = await text(box.id, "first line");
    const second = await text(box.id, "second line");
    const third = await text(box.id, "third line");
    const after = await text(pageId, "after the box");
    return {
      box: box.id,
      first: first.id,
      second: second.id,
      third: third.id,
      after: after.id,
    };
  })();
  console.log("seeded:", JSON.stringify(seeded));

  await page.reload({ waitUntil: "domcontentloaded" });
  // WAIT for the seed to be on screen rather than guessing a settle time — a
  // cold SPA boot paints its first row 2-3s after `domcontentloaded`, and every
  // gesture below would otherwise run against a blank page. The wait is on the
  // LAST row posted, so its arrival proves the whole seed is rendered.
  await page
    .locator(`[data-block-id="${seeded.after}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "1-seeded");

  // The page's own rows BEFORE the paste, so "nothing landed loose" below is a
  // claim about what the paste ADDED rather than about the seed's exact shape.
  const before = await rows(page, pageId);
  const loosePageText = (all: Row[]) =>
    all.filter((b) => b.parentId === pageId && b.type === "text").length;

  // --- 1. A partly covered box is NOT selected -------------------------------
  const firstLine = await editableIndexOf(page, seeded.first);
  await enterBlockSelection("partial", firstLine, "Shift+ArrowDown"); // lines 1-2 of 3
  const partial = await highlightedLines(page);
  await snap(page, out, "2-partial");
  r.eq(
    "partial cover: two of the card's three lines highlight TWO lines — the box is not selected",
    partial,
    2,
  );

  // --- 2. Covering every line selects the box --------------------------------
  await page.keyboard.press("Shift+ArrowDown"); // lines 1-3: the whole card
  await page.waitForTimeout(300);
  const full = await highlightedLines(page);
  await snap(page, out, "3-full");
  r.eq(
    "full cover: the highlight spans the container's frame — its anchor row plus all three children",
    full,
    4,
  );

  // --- 3. Copy then paste round-trips a real container ------------------------
  await checkSelectionOwnsFocus("copy");
  await page.keyboard.press("Meta+c");
  await page.waitForTimeout(400);
  await checkSelectionOwnsFocus("paste");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2500); // server insert + push round-trip
  await snap(page, out, "4-pasted");

  const after = await rows(page, pageId);
  const callouts = after.filter((b) => b.type === "callout");
  r.eq(
    "paste: a SECOND callout row exists — the box travelled with its contents",
    callouts.length,
    2,
  );
  const copy = callouts.find((b) => b.id !== seeded.box);
  if (!copy) {
    return await bail(
      "paste: the pasted callout is identifiable",
      JSON.stringify(callouts),
    );
  }
  const copyKids = after.filter((b) => b.parentId === copy.id);
  r.eq(
    "paste: the pasted box holds three text children of its own",
    copyKids.map((b) => b.type).sort(),
    ["text", "text", "text"],
  );
  r.eq(
    "paste: the copies are INSIDE the new box — nothing landed loose on the page",
    loosePageText(after),
    loosePageText(before),
  );
  r.eq(
    "paste: the original box still holds its own three children",
    after.filter((b) => b.parentId === seeded.box).length,
    3,
  );
});

await r.finish();
