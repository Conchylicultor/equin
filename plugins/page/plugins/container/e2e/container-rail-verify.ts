// The gutter rail on a container's BORROWED line belongs to the CONTAINER.
//
// A void container renders no line of its own — its content IS its children — so
// it borrows its first visible child's line. Four affordances then share one
// visual line, and they used to disagree about what they act on: the chevron
// targeted the container, while `+`, the drag handle and the block-actions menu
// implicitly targeted the child. Dragging the handle on a callout's first line
// pulled that line OUT of the box. `RailSeat.owner` resolves the whole line to
// ONE owner, and this file is the spec for what that buys.
//
// It is a SIBLING of `container-collapse-verify.ts`, not more of it. That file's
// six claims are all about the FOLD — one thesis, one seed shape, one stated
// preamble. These are about OWNERSHIP: which block each control acts on, and
// which menu the handle opens. Different subject, different gestures (drag, `+`,
// popover contents), and merging them would leave neither file's preamble true.
//
// Every claim below is invisible to a unit test and most of them to jsdom,
// because they are about REAL POINTER GESTURES against the deployed surface and
// about what a popover actually contains:
//
//  1. THE BORROWED LINE'S `⠿` OPENS THE CONTAINER'S MENU — Remove callout /
//     Delete / Collapse — and NOT "Turn into". A container owns no text, so
//     converting it away has nowhere to put its children; the arm is selected by
//     the core fact `BlockHandle.anchor`, and "Remove callout" derives its
//     wording from the handle's own label.
//  2. LINE 2's RAIL STILL TARGETS LINE 2. Only the borrowed LINE transfers
//     ownership — lines 2..n inside the box own themselves. Its handle opens the
//     ORDINARY menu (Turn into), which is the same assertion stated from the
//     other side, and the one that would fail if `owner` were a plain "am I
//     inside a frame" span rule.
//  3. THE GLYPH IS APPEARANCE, AND ONLY APPEARANCE. It used to carry the whole
//     block-actions menu because an anchor row has no rail to hang one off; it
//     now opens the icon/colour controls alone. (Those same controls ALSO render
//     in the rail menu, deliberately — asserted in 1.)
//  4. `+` ON THE BORROWED LINE LANDS A BLOCK AFTER THE BOX. `insertAfter`
//     resolves the owner's parent, so the new line is a sibling of the CALLOUT,
//     not of its first child. This is the most visible behaviour change of the
//     whole rail-ownership model, so it is asserted structurally (the new row's
//     `parentId` is the page, not the box) rather than by eyeballing an indent.
//  5. DRAGGING LINE 2's HANDLE MOVES LINE 2 OUT, and the box keeps the rest.
//  6. DRAGGING THE BORROWED LINE'S HANDLE MOVES THE WHOLE BOX — the container
//     row is reparented and its children follow by `parentId`, so the box is
//     still a box afterwards with the same children inside it. This is the
//     reported bug, in its final form.
//
// The container under test is `callout` (it has a `label`, so the derived
// "Remove callout" wording is checkable). The behaviour belongs to the container
// primitive and to the editor's rail, so `context` inherits it unchanged.
//
// Usage: bun plugins/page/plugins/container/e2e/container-rail-verify.ts [--url <deploy>] [--out /tmp/rail]
import {
  pageFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openBlankPage, pageIdFromUrl } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/rail");
const r = report();

const HANDLE = 'button[aria-label="Reorder or open block actions"]';
const PLUS = 'button[aria-label="Insert block below"]';
const GLYPH = 'button[aria-label="Callout icon and color"]';

/** Record one failure and stop. Used where nothing further is checkable. */
async function bail(name: string, detail: string): Promise<never> {
  r.fail(name, detail);
  return await r.finish();
}

/** The ids currently rendered, in document order. */
async function rendered(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id]")]
      .map((el) => el.getAttribute("data-block-id"))
      .filter((id): id is string => id !== null),
  );
}

/**
 * The page's rows as the SERVER holds them — id → parentId.
 *
 * Structure, not pixels: "the children are still inside the box" is a claim
 * about `parentId`, and reading it back from the API is what makes the drag
 * assertions immune to how the frame happens to be painted (and proves the move
 * was persisted rather than merely rendered).
 */
async function parentage(
  page: Page,
  pageId: string,
): Promise<Record<string, string | null>> {
  const res = await pageFetch(page, `/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`GET blocks ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as {
    id: string;
    parentId: string | null;
  }[];
  return Object.fromEntries(rows.map((b) => [b.id, b.parentId]));
}

/**
 * Park the pointer over a row's text, well clear of the gutter controls.
 *
 * A row that is not on screen is a hard STOP, not a move quietly skipped. The
 * controls this hover was going to reveal stay `pointer-events-none` without
 * it, so every later click on them spins out its whole timeout against a hit
 * test that can never pass — which is how a page that simply had not finished
 * rendering used to surface, 30s downstream, as an inexplicably unclickable
 * handle. Bail where the fault actually is.
 */
async function hoverText(page: Page, id: string): Promise<void> {
  const box = await page.evaluate((blockId) => {
    const el = document.querySelector<HTMLElement>(
      `[data-block-id="${blockId}"]`,
    );
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width * 0.6, y: b.top + Math.min(12, b.height / 2) };
  }, id);
  if (!box)
    return await bail(`hover: ${id} is on screen`, "no such row in the DOM");
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(200);
}

/**
 * Which of the named entries the OPEN popover contains.
 *
 * Scoped to the popover's own content box, never the page: a page-wide
 * `getByText("Delete")` also finds chrome elsewhere in the app (the Pages
 * sidebar's row actions), which reported "the glyph still carries Delete" while
 * the glyph's popover held nothing but colours, the icon picker and Reset —
 * a false FAILURE, and equally capable of producing a false PASS.
 *
 * `isVisible()` on a locator matching nothing resolves to `false` rather than
 * rejecting — "absent" is the answer here, not a swallowed failure — so this
 * needs no catch, and a genuine Playwright error still propagates.
 */
async function menuEntries(page: Page): Promise<string[]> {
  const names = ["Turn into", "Collapse", "Expand", "Remove callout", "Delete"];
  const popover = page.locator('[data-slot="popover-content"]');
  const seen: string[] = [];
  for (const name of names) {
    if (await popover.getByText(name, { exact: true }).first().isVisible())
      seen.push(name);
  }
  return seen;
}

async function dismiss(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
}

/**
 * Open the menu the rail handle on `rowId` carries, and read its entries.
 *
 * The row must be hovered first, and that is not a tidiness measure: gutter
 * controls are `opacity-0 pointer-events-none` until their row is hovered, and
 * Playwright runs its actionability hit test BEFORE it moves the pointer — so a
 * cold `.click()` lands on the row beneath the handle and retries until its
 * timeout expires, however long it is given (measured: three cold clicks on a
 * fully rendered page, three timeouts). The hover is what makes the control
 * clickable at all, which is exactly why `hoverText` refuses to miss quietly.
 */
async function openRailMenu(page: Page, rowId: string): Promise<string[]> {
  await hoverText(page, rowId);
  await page.locator(`[data-block-id="${rowId}"] ${HANDLE}`).first().click();
  await page.waitForTimeout(600);
  return menuEntries(page);
}

/**
 * Drag `rowId`'s rail handle onto the LOWER half of `ontoId`'s row and drop.
 *
 * dnd-kit's PointerSensor needs ~4px of movement before it activates, so the
 * gesture is a real down → nudge → travel → up, not a `dragTo`.
 */
async function dragHandleOnto(
  page: Page,
  rowId: string,
  ontoId: string,
): Promise<void> {
  await hoverText(page, rowId);
  const from = await page
    .locator(`[data-block-id="${rowId}"] ${HANDLE}`)
    .first()
    .boundingBox();
  const target = await page
    .locator(`[data-block-id="${ontoId}"]`)
    .first()
    .boundingBox();
  if (!from || !target)
    return await bail(
      `drag: ${rowId} and ${ontoId} both render`,
      `from=${!!from} to=${!!target}`,
    );

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 8, {
    steps: 5,
  });
  // The lower half resolves to "after this row" in the editor's drop handler.
  await page.mouse.move(
    target.x + target.width * 0.5,
    target.y + target.height * 0.8,
    { steps: 20 },
  );
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(1500);
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const doc = await openBlankPage(page, { settleMs: 800 });
  const pageId = pageIdFromUrl(doc.pageUrl);

  // A callout with THREE children (so a fold is genuinely on offer) plus one
  // block after the box, which is both the drop target for the drags and the
  // reference for "the `+` landed OUTSIDE".
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
  // WAIT for the seed to be on screen; do not guess a settle time. A cold SPA
  // boot paints its first row 2–3s after `domcontentloaded` (measured), so the
  // fixed 1600ms pause this used to take resumed against a BLANK page: the
  // first `hoverText` found no row, revealed no rail, and the click below then
  // ran out its full timeout on a handle that could never become clickable —
  // the page having painted in the meantime made no difference (see
  // `openRailMenu`). The wait is on the LAST row posted, so its arrival proves
  // the whole seed is rendered rather than the head of it.
  await page
    .locator(`[data-block-id="${seeded.after}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "1-seeded");

  // --- 1. The borrowed line's handle opens the CONTAINER's menu ---------------
  const containerMenu = await openRailMenu(page, seeded.first);
  console.log("borrowed-line menu:", JSON.stringify(containerMenu));
  await snap(page, out, "2-container-menu");
  r.ok(
    "borrowed line: the rail menu offers Remove callout — the CONTAINER's action",
    containerMenu.includes("Remove callout"),
    JSON.stringify(containerMenu),
  );
  r.ok(
    "borrowed line: ...and Collapse, the fold's fallback for the cases the chevron cannot serve",
    containerMenu.includes("Collapse"),
    JSON.stringify(containerMenu),
  );
  r.ok(
    "borrowed line: ...and Delete, which is a DIFFERENT intent from Remove",
    containerMenu.includes("Delete"),
    JSON.stringify(containerMenu),
  );
  r.ok(
    "borrowed line: NO Turn into — a void container has nowhere to put its children",
    !containerMenu.includes("Turn into"),
    JSON.stringify(containerMenu),
  );
  // The callout's own appearance is contributed INTO this menu, so the rail is a
  // complete surface for the block rather than a structural half of one.
  const swatchInMenu = await page
    .locator('[data-slot="popover-content"] button[aria-label="info"]')
    .first()
    .isVisible();
  r.ok(
    "borrowed line: the container's appearance sections render in the rail menu too",
    swatchInMenu,
  );
  await dismiss(page);

  // --- 2. Line 2's rail still targets line 2 ---------------------------------
  const ordinaryMenu = await openRailMenu(page, seeded.second);
  console.log("line-2 menu:", JSON.stringify(ordinaryMenu));
  r.ok(
    "line 2: the rail menu is the ORDINARY one (Turn into) — only the BORROWED line transfers ownership",
    ordinaryMenu.includes("Turn into"),
    JSON.stringify(ordinaryMenu),
  );
  r.ok(
    "line 2: it offers no container action",
    !ordinaryMenu.includes("Remove callout"),
    JSON.stringify(ordinaryMenu),
  );
  await dismiss(page);

  // --- 3. The glyph is appearance, and only appearance ------------------------
  await page
    .locator(`[data-block-id="${seeded.box}"] ${GLYPH}`)
    .first()
    .click();
  await page.waitForTimeout(600);
  await snap(page, out, "3-glyph-menu");
  const glyphMenu = await menuEntries(page);
  const glyphSwatch = await page
    .locator('[data-slot="popover-content"] button[aria-label="info"]')
    .first()
    .isVisible();
  console.log("glyph menu:", JSON.stringify(glyphMenu));
  r.ok("glyph: it opens the icon/colour controls", glyphSwatch);
  r.ok(
    "glyph: and NOTHING structural — those moved to the rail on the borrowed line",
    glyphMenu.length === 0,
    JSON.stringify(glyphMenu),
  );
  await dismiss(page);

  // --- 4. `+` on the borrowed line lands a block AFTER the box ----------------
  const beforePlus = await rendered(page);
  await hoverText(page, seeded.first);
  await page
    .locator(`[data-block-id="${seeded.first}"] ${PLUS}`)
    .first()
    .click();
  await page.waitForTimeout(1200);
  // `+` inserts the block immediately and opens the block-type menu over it;
  // Esc keeps the block and clears the draft (that is the documented contract).
  await dismiss(page);
  await page.waitForTimeout(800);
  await snap(page, out, "4-plus-after-box");

  const afterPlus = await rendered(page);
  const minted = afterPlus.filter((id) => !beforePlus.includes(id));
  console.log(
    "minted by +:",
    JSON.stringify(minted),
    "order:",
    JSON.stringify(afterPlus),
  );
  const newId = minted.at(-1);
  r.ok(
    "plus: a new line was created",
    newId != null,
    `minted=${minted.length}`,
  );

  if (newId) {
    const rows = await parentage(page, pageId);
    r.ok(
      "plus: the new line is a sibling of the CALLOUT, not of its first child",
      rows[newId] === pageId,
      `parent=${rows[newId]} page=${pageId} box=${seeded.box}`,
    );
    r.ok(
      "plus: ...and it sits AFTER the whole box in document order",
      afterPlus.indexOf(newId) > afterPlus.indexOf(seeded.third),
      JSON.stringify(afterPlus),
    );
  }

  // --- 5. Line 2's handle drags line 2 OUT ------------------------------------
  await dragHandleOnto(page, seeded.second, seeded.after);
  await snap(page, out, "5-line-2-dragged-out");
  const afterLineDrag = await parentage(page, pageId);
  console.log(
    "parentage after dragging line 2:",
    JSON.stringify(afterLineDrag),
  );
  r.ok(
    "line 2: dragging its handle moves LINE 2 — it leaves the box",
    afterLineDrag[seeded.second] === pageId,
    `parent=${afterLineDrag[seeded.second]}`,
  );
  r.ok(
    "line 2: ...and the box keeps the rest of its children",
    afterLineDrag[seeded.first] === seeded.box &&
      afterLineDrag[seeded.third] === seeded.box,
    JSON.stringify({
      first: afterLineDrag[seeded.first],
      third: afterLineDrag[seeded.third],
      box: seeded.box,
    }),
  );

  // --- 6. The borrowed line's handle drags the WHOLE box ----------------------
  //
  // The reported bug, in its final form: this gesture used to pull the first
  // line out of the callout, leaving a one-child box behind.
  const orderBefore = await rendered(page);
  await dragHandleOnto(page, seeded.first, seeded.after);
  await snap(page, out, "6-box-dragged");
  const afterBoxDrag = await parentage(page, pageId);
  const orderAfter = await rendered(page);
  console.log("order before:", JSON.stringify(orderBefore));
  console.log("order after:", JSON.stringify(orderAfter));
  console.log(
    "parentage after dragging the box:",
    JSON.stringify(afterBoxDrag),
  );

  r.ok(
    "box drag: the FIRST LINE did not leave the box — the handle moved the container, not the child",
    afterBoxDrag[seeded.first] === seeded.box,
    `parent=${afterBoxDrag[seeded.first]} box=${seeded.box}`,
  );
  r.ok(
    "box drag: every child is still inside it — children follow their parent by parentId",
    afterBoxDrag[seeded.first] === seeded.box &&
      afterBoxDrag[seeded.third] === seeded.box,
    JSON.stringify({
      first: afterBoxDrag[seeded.first],
      third: afterBoxDrag[seeded.third],
    }),
  );
  r.ok(
    "box drag: the box itself moved — it now follows the block it was dropped on",
    orderAfter.indexOf(seeded.box) > orderAfter.indexOf(seeded.after) &&
      orderBefore.indexOf(seeded.box) < orderBefore.indexOf(seeded.after),
    `before=${orderBefore.indexOf(seeded.box)}/${orderBefore.indexOf(seeded.after)} after=${orderAfter.indexOf(seeded.box)}/${orderAfter.indexOf(seeded.after)}`,
  );
  r.ok(
    "box drag: the box is still a box — its rows stay contiguous, first line included",
    orderAfter.indexOf(seeded.first) === orderAfter.indexOf(seeded.box) + 1,
    JSON.stringify(orderAfter),
  );
});

await r.finish();
