// Callout-as-VOID-container verification.
//
// A callout owns no text. It is an ANCHOR: a `{icon, color}` row
// that renders no line of its own, whose content IS its children — ordinary
// blocks of any type that do not know they are inside it. Everything that used
// to be a callout special case is now a plain operation on a plain block, and
// every claim below is invisible to a unit test of the pure grouping, so it is
// asserted here against the real editable surface.
//
//  1. SEED four callouts through the API + cold-load. The payloads carry NO
//     `text` key — a void schema 400s one — which is itself the first assertion.
//  2. CHILDLESS BOX: a callout with no children renders a VISIBLE one-line box.
//     Asserted FIRST, deliberately: `pruneEmptyAnchors` is a forest-wide
//     post-pass on `applyBlockOp`, so the very next structural keystroke on this
//     page dissolves it.
//  3. ZERO HEIGHT: an anchor row with visible children measures 0px — that is
//     what puts its icon and its first child on ONE visual line.
//  4. THE COLLISION REGRESSION: the icon's box lies inside the one-indent column
//     `[C+BLOCK_INSET, C+BLOCK_INSET+BLOCK_INDENT]` — the glyph seats inside the
//     box it decorates, and that box is the callout's own CONTENT box, one
//     `BLOCK_INSET` right of the decoration origin `C` (it used to paint from `C`
//     itself, which left the tint standing to the left of every paragraph on the
//     page) — and is genuinely CLICKABLE while the first child is an EXPANDED
//     PARENT block — i.e. exactly when that child's own chevron would sit in the
//     icon's column under the naive "each row seats its rail against its own
//     content edge" rule. This is the case the whole outermost-frame rail rule
//     exists to fix; hit-test it, don't eyeball it.
//  5. VERTICAL SEATING: the icon's centre sits within ~2px of the first child's
//     first-line centre — measured against the gutter handle rendered on that
//     child's ROW, which is seated by the same rule, so the two cannot silently
//     drift. (That handle now ACTS on the callout, since the rail on a borrowed
//     line belongs to the container; here it is used purely as a y reference.)
//  6. ENTER: Enter at the end of a callout's first child yields a SIBLING text
//     block still inside the tint — not a second callout. (The originally
//     reported bug: five sibling callout rows, each with its own icon.)
//  7. TURN INTO: `/h1` on that first child leaves the tint and the icon intact.
//     (The second reported bug: converting the line destroyed the callout,
//     because the line's type WAS the container's identity.)
//  8. TAB IN / TAB OUT: the caret survives crossing the frame boundary. The
//     load-bearing frame test, kept verbatim.
//  9. BACKSPACE: at the start of a callout's only child it UNWRAPS — the child
//     pops out and the callout disappears (never the generic outdent rung, which
//     would adopt the remaining siblings as that child's children).
// 10. converge in a SECOND browser context (fresh socket, cold load).
//
// Usage: bun plugins/page/plugins/callout/e2e/callout-container-verify.ts [--url <deploy>] [--out /tmp/callout]
import {
  pageFetch,
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

const out = arg("out", "/tmp/callout");

const r = report();

interface FrameProbe {
  /** Did a painted backdrop covering the anchor's row exist? */
  framed: boolean;
  /** Does that backdrop also swallow the block AFTER the callout? */
  leaksOutsider: boolean;
  tint?: { top: number; bottom: number; left: number };
  anchor?: { top: number; bottom: number; left: number; contentLeft: number };
  tail?: { top: number; bottom: number };
  outsiderTop?: number;
}

/**
 * Read the frame's geometry straight off the DOM.
 *
 * The frame is a SIBLING backdrop spanning grid lines, never an ancestor of the
 * rows (see the editor's `internal/block-frames.ts`: wrapping the rows would
 * remount a block's editor whenever it is indented across the boundary). So this
 * asserts what the user actually sees — does a painted box cover the container's
 * rows and stop before the next block — rather than DOM ancestry, which would
 * say nothing about whether the box is in the right place.
 *
 * `anchorId` is the callout's own row, which is ZERO height while it has
 * children; its single pixel line is where the box must start.
 */
async function probeFrame(
  page: Page,
  anchorId: string,
  tailId: string,
  outsiderId: string,
): Promise<FrameProbe> {
  return page.evaluate(
    ({ anchorId, tailId, outsiderId }) => {
      const row = (id: string) =>
        document.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
      const anchor = row(anchorId);
      const tail = row(tailId);
      const outsider = row(outsiderId);
      if (!anchor || !tail || !outsider)
        return { framed: false, leaksOutsider: false };

      // Rows sit one wrapper deep in the block grid; the backdrops are siblings
      // of those wrappers, holding no rows of their own.
      const grid = anchor.parentElement?.parentElement;
      if (!grid) return { framed: false, leaksOutsider: false };

      const painted = (el: HTMLElement): HTMLElement | null => {
        const all = [el, ...el.querySelectorAll<HTMLElement>("div")];
        return (
          all.find((n) => {
            const bg = getComputedStyle(n).backgroundColor;
            return (
              bg !== "" &&
              bg !== "transparent" &&
              !bg.startsWith("rgba(0, 0, 0, 0)")
            );
          }) ?? null
        );
      };

      const anchorRect = anchor.getBoundingClientRect();
      const backdrop = [...grid.children]
        .filter((c): c is HTMLElement => c instanceof HTMLElement)
        .filter((c) => c.querySelector("[data-block-id]") === null)
        .map(painted)
        .filter((n): n is HTMLElement => n !== null)
        // The backdrop covering THIS container: the one whose box contains the
        // anchor's (zero-height) row line.
        .find((n) => {
          const b = n.getBoundingClientRect();
          return (
            b.top <= anchorRect.top + 1 && b.bottom >= anchorRect.bottom - 1
          );
        });

      if (!backdrop) return { framed: false, leaksOutsider: false };

      const tailRect = tail.getBoundingClientRect();
      const outsiderRect = outsider.getBoundingClientRect();
      const b = backdrop.getBoundingClientRect();
      return {
        framed: true,
        // The backdrop must NOT reach the block after the container.
        leaksOutsider: b.bottom > outsiderRect.top + 1,
        tint: { top: b.top, bottom: b.bottom, left: b.left },
        anchor: {
          top: anchorRect.top,
          bottom: anchorRect.bottom,
          left: anchorRect.left,
          contentLeft:
            anchorRect.left +
            parseFloat(getComputedStyle(anchor).paddingLeft || "0"),
        },
        tail: { top: tailRect.top, bottom: tailRect.bottom },
        outsiderTop: outsiderRect.top,
      };
    },
    { anchorId, tailId, outsiderId },
  );
}

/** A block row's content-edge inset, in px — one BLOCK_INDENT deeper per level. */
async function contentEdge(page: Page, id: string): Promise<number> {
  return page.evaluate((blockId) => {
    const el = document.querySelector<HTMLElement>(
      `[data-block-id="${blockId}"]`,
    );
    return el ? parseFloat(getComputedStyle(el).paddingLeft) : -1;
  }, id);
}

/** A block row's own box height (0 for an anchor row with visible children). */
async function rowHeight(page: Page, id: string): Promise<number> {
  return page.evaluate(
    (blockId) =>
      document
        .querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
        ?.getBoundingClientRect().height ?? -1,
    id,
  );
}

interface AnchorProbe {
  found: boolean;
  /** The container's content edge `C`, in viewport px. */
  contentEdge?: number;
  /** One indent, derived from the first child's own edge (never hardcoded). */
  indent?: number;
  /**
   * One `BLOCK_INSET`, derived from an ordinary unframed text row: the gap
   * between where that row's box is MEASURED from (its content edge) and where
   * its first glyph actually lands. Never hardcoded — `BLOCK_INSET` is the
   * `--space-md` token and follows the density preset, so 12px is only today's
   * answer at today's default.
   */
  inset?: number;
  icon?: { left: number; right: number; top: number; bottom: number };
  /** What is actually hit-tested at the icon's centre. */
  hitIsIcon?: boolean;
  hitTag?: string;
  /** Centre-y of the gutter drag handle on the first child's row (same seating rule). */
  childHandleCenterY?: number;
}

/**
 * The anchor decoration's real, hit-tested geometry.
 *
 * `elementFromPoint` rather than a rect comparison on purpose: the failure this
 * guards is not "the icon is in the wrong place", it is "the icon is in the
 * right place and something later in DOM order at the same stacking level is
 * on top of it", which only a hit test can see.
 */
async function probeAnchor(
  page: Page,
  calloutId: string,
  firstChildId: string,
  insetRowId: string,
): Promise<AnchorProbe> {
  return page.evaluate(
    ({ calloutId, firstChildId, insetRowId }) => {
      const anchorRow = document.querySelector<HTMLElement>(
        `[data-block-id="${calloutId}"]`,
      );
      const childRow = document.querySelector<HTMLElement>(
        `[data-block-id="${firstChildId}"]`,
      );
      if (!anchorRow || !childRow) return { found: false };
      const icon = anchorRow.querySelector<HTMLElement>(
        'button[aria-label="Callout icon and color"]',
      );
      if (!icon) return { found: false };

      const anchorRect = anchorRow.getBoundingClientRect();
      const childRect = childRow.getBoundingClientRect();
      const contentEdge =
        anchorRect.left +
        parseFloat(getComputedStyle(anchorRow).paddingLeft || "0");
      const childEdge =
        childRect.left +
        parseFloat(getComputedStyle(childRow).paddingLeft || "0");

      // One `BLOCK_INSET`, read off a plain unframed paragraph: how far its
      // first glyph sits from the edge its box is measured from. That is the
      // same step the callout's box (and so its glyph column) now takes.
      const insetRow = document.querySelector<HTMLElement>(
        `[data-block-id="${insetRowId}"]`,
      );
      const insetText = insetRow?.querySelector<HTMLElement>(
        '[contenteditable="true"]',
      );
      const insetRect = insetRow?.getBoundingClientRect();
      const inset =
        insetRow && insetText && insetRect
          ? insetText.getBoundingClientRect().left -
            (insetRect.left +
              parseFloat(getComputedStyle(insetRow).paddingLeft || "0"))
          : undefined;

      const box = icon.getBoundingClientRect();

      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      const handle = childRow.querySelector<HTMLElement>(
        'button[aria-label="Reorder or open block actions"]',
      );
      const handleRect = handle?.getBoundingClientRect();

      return {
        found: true,
        contentEdge,
        indent: childEdge - contentEdge,
        inset,
        icon: {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
        },
        hitIsIcon: hit != null && (hit === icon || icon.contains(hit)),
        hitTag: hit ? `${hit.tagName}.${hit.className}` : "none",
        childHandleCenterY: handleRect
          ? handleRect.top + handleRect.height / 2
          : undefined,
      };
    },
    { calloutId, firstChildId, insetRowId },
  );
}

/**
 * The block ids of every row currently painting a callout decoration.
 *
 * A SET, not a count, deliberately: `pruneEmptyAnchors` is a forest-wide
 * post-pass, so any structural op may legitimately REMOVE a childless anchor
 * elsewhere on the page. "Enter did not mint a second callout" is therefore
 * "no NEW id appeared", which a count would conflate with an unrelated prune.
 */
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

/** Put the caret at the end of a block's text by clicking past its last glyph. */
async function caretToEnd(page: Page, blockId: string): Promise<boolean> {
  const editable = page
    .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
    .first();
  const box = await editable.boundingBox();
  if (!box) return false;
  // Clicking past the end lands at the end; End / Cmd+ArrowRight do not move the
  // caret in headless Chromium on macOS.
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await page.waitForTimeout(400);
  return true;
}

/** Put the caret at offset 0 by clicking the text's very left edge. */
async function caretToStart(page: Page, blockId: string): Promise<boolean> {
  const editable = page
    .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
    .first();
  const box = await editable.boundingBox();
  if (!box) return false;
  await editable.click({ position: { x: 2, y: Math.min(12, box.height / 2) } });
  await page.waitForTimeout(400);
  return true;
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const { pageUrl, pageId } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);

  // --- 1. seed --------------------------------------------------------------
  //
  // Four callouts, each isolating one claim:
  //   C1  → first child is an EXPANDED PARENT   (geometry + the collision case)
  //   C2  → one plain first child               (Enter, /h1)
  //   C3  → NO children                         (the visible one-line box)
  //   C4  → exactly one child                   (Backspace → unwrap)
  //
  // The `data` payloads carry no `text` key: the callout schema is VOID, and the
  // write boundary's strict parse rejects a stray one (400). A seed that still
  // posted `{text, icon, …}` — as this script's predecessor did — is itself the
  // regression.
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
    const callout = (color: string) =>
      post({
        parentId: pageId,
        type: "callout",
        data: { icon: null, color },
      });
    const text = (parentId: string, type: string, body: string) =>
      post({ parentId, type, data: { text: [{ text: body }] } });

      const c1 = await callout("info");
      const c1First = await text(c1.id, "text", "parent line");
      const c1Grand = await text(c1First.id, "bulleted-list", "inside");
      const outsider = await text(pageId, "text", "outside");
      const afterC1 = await text(pageId, "text", "after all");

      const c2 = await callout("warning");
      const c2First = await text(c2.id, "text", "solo line");

      const c3 = await callout("success");

      const c4 = await callout("danger");
      const c4Only = await text(c4.id, "text", "only child");
      const end = await text(pageId, "text", "the end");

      return {
        c1: c1.id,
        c1First: c1First.id,
        c1Grand: c1Grand.id,
        outsiderId: outsider.id,
        afterC1: afterC1.id,
        c2: c2.id,
        c2First: c2First.id,
        c3: c3.id,
        c4: c4.id,
        c4Only: c4Only.id,
        end: end.id,
      };
  })();
  console.log("seeded:", JSON.stringify(seeded));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(`[data-block-id="${seeded.c1Grand}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "1-seeded");

  r.ok(
    "seed: a VOID callout payload is accepted (no `text` key posted)",
    seeded.c1.length > 0,
  );
  const firstText = await blockText(
    page
      .locator(`[data-block-id="${seeded.c1First}"] [contenteditable="true"]`)
      .first(),
  );
  r.ok(
    "seed: the callout's first child holds its own text",
    firstText === "parent line",
    firstText,
  );

  const c1Edge = await contentEdge(page, seeded.c1);
  const c1FirstEdge = await contentEdge(page, seeded.c1First);
  r.ok(
    "seed: the first child is NESTED inside the callout (one indent deeper)",
    c1FirstEdge > c1Edge,
    `callout=${c1Edge} child=${c1FirstEdge}`,
  );

  // --- 2. childless callout renders a VISIBLE one-line box --------------------
  // FIRST, before any structural keystroke: `pruneEmptyAnchors` is a forest-wide
  // post-pass on every `applyBlockOp`, so the next Enter on this page dissolves
  // C3. The claim under test is the surface's, not the reducer's — a childless
  // anchor must not be a zero-height, unclickable, undeletable ghost.
  const c3Height = await rowHeight(page, seeded.c3);
  const c3Frame = await probeFrame(page, seeded.c3, seeded.c3, seeded.c4);
  console.log(
    "childless callout:",
    JSON.stringify({ c3Height, tint: c3Frame.tint }),
  );
  r.ok(
    "childless: the anchor row falls back to a real one-line box",
    c3Height > 12,
    `height=${c3Height}`,
  );
  r.ok(
    "childless: that box is actually painted (a visible tint, not a 0px ghost)",
    c3Frame.framed &&
      c3Frame.tint != null &&
      c3Frame.tint.bottom - c3Frame.tint.top > 12,
    JSON.stringify(c3Frame.tint),
  );

  // --- 3. an anchor with visible children is ZERO height ----------------------
  const c1Height = await rowHeight(page, seeded.c1);
  r.ok(
    "anchor: the row collapses to zero height while it has visible children",
    c1Height === 0,
    `height=${c1Height}`,
  );

  // --- 4/5. the decoration column: geometry, hit-test, vertical seat ----------
  // Hover the first child FIRST: its gutter controls are `pointer-events-none`
  // until hovered, so a hit test taken cold would pass even if they overlapped.
  await page.locator(`[data-block-id="${seeded.c1First}"]`).first().hover();
  await page.waitForTimeout(300);
  // `outsider` is the inset yardstick: a plain, unframed, page-level paragraph,
  // measured before phase 8 Tabs it into the callout.
  const anchorProbe = await probeAnchor(
    page,
    seeded.c1,
    seeded.c1First,
    seeded.outsiderId,
  );
  console.log("anchor probe:", JSON.stringify(anchorProbe));
  if (!anchorProbe.found || !anchorProbe.icon) {
    r.fail(
      "anchor: the callout paints a decoration",
      JSON.stringify(anchorProbe),
    );
  } else {
    const { icon, contentEdge: C = 0, indent = 0, inset } = anchorProbe;
    // The glyph column sits inside the box it decorates, and that box is the
    // callout's own CONTENT box — so the column starts one `BLOCK_INSET` right
    // of the decoration origin `C`, on the same x as the first letter of an
    // ordinary paragraph. It used to start at `C` itself, which put the tint and
    // the icon to the LEFT of every paragraph on the page.
    //
    // The inset is MEASURED off that paragraph rather than written down: it is
    // the `--space-md` token, so a density preset moves it and a hardcoded 12
    // would make this assertion a statement about today's theme.
    if (inset === undefined) {
      r.fail(
        "anchor: an ordinary paragraph was measurable, to read one BLOCK_INSET off it",
        JSON.stringify(anchorProbe),
      );
    } else {
      r.ok(
        "anchor: the icon sits inside the one-indent column [C+BLOCK_INSET, C+BLOCK_INSET+BLOCK_INDENT]",
        icon.left >= C + inset - 1 && icon.right <= C + inset + indent + 1,
        `icon=[${icon.left},${icon.right}] C=${C} inset=${inset} indent=${indent}`,
      );
    }
    r.ok(
      "anchor: the icon is CLICKABLE with an expanded parent as first child",
      anchorProbe.hitIsIcon === true,
      `hit=${anchorProbe.hitTag}`,
    );
    if (anchorProbe.childHandleCenterY != null) {
      const iconCenter = icon.top + (icon.bottom - icon.top) / 2;
      r.ok(
        "anchor: the icon's centre matches the first child's first-line centre",
        Math.abs(iconCenter - anchorProbe.childHandleCenterY) <= 2,
        `icon=${iconCenter} childHandle=${anchorProbe.childHandleCenterY}`,
      );
    } else {
      r.fail(
        "anchor: the first child exposes its own gutter handle to compare against",
      );
    }

    // And the click really opens the callout's APPEARANCE controls. The icon no
    // longer carries the structural actions (Remove callout / Delete / Collapse)
    // — those live on the rail of the line the callout borrows, which owns them
    // for every container generically; `container/e2e/container-rail-verify.ts`
    // is their spec. What is left here is the callout's own payload, and a dead
    // icon is still a callout that cannot be re-coloured.
    await page
      .locator(
        `[data-block-id="${seeded.c1}"] button[aria-label="Callout icon and color"]`,
      )
      .first()
      .click();
    await page.waitForTimeout(600);
    // Scoped to the popover's own content box: a page-wide text query also finds
    // chrome elsewhere in the app, which is a false PASS waiting to happen.
    const popover = page.locator('[data-slot="popover-content"]');
    const swatchVisible = await popover
      .locator('button[aria-label="info"]')
      .first()
      .isVisible();
    const structuralLeaked = await popover
      .getByText("Remove callout", { exact: true })
      .first()
      .isVisible();
    await snap(page, out, "2-icon-menu");
    r.ok(
      "anchor: clicking the icon opens the callout's appearance controls",
      swatchVisible,
    );
    r.ok(
      "anchor: and nothing structural — that menu moved to the borrowed line's rail",
      !structuralLeaked,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  const anchorsBefore = await anchorIds(page);
  console.log("anchor rows before Enter:", JSON.stringify(anchorsBefore));

  // --- 6. Enter at the end of a first child yields a SIBLING, not a callout ----
  if (await caretToEnd(page, seeded.c2First)) {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    await page.keyboard.type("second line", { delay: 25 });
    await page.waitForTimeout(1800);
    await snap(page, out, "3-enter-sibling");

    const known = Object.values(seeded);
    const newIds = await page.evaluate(
      ({ known }) =>
        [...document.querySelectorAll("[data-block-id]")]
          .map((el) => el.getAttribute("data-block-id"))
          .filter((id): id is string => id !== null && !known.includes(id)),
      { known },
    );
    const splitId = newIds.at(-1);
    console.log("new ids after Enter:", JSON.stringify(newIds));
    r.ok(
      "enter: a new line was created",
      splitId != null,
      `new=${newIds.length}`,
    );

    if (splitId) {
      const splitText = await blockText(
        page
          .locator(`[data-block-id="${splitId}"] [contenteditable="true"]`)
          .first(),
      );
      r.ok(
        "enter: typing landed in the new line",
        splitText === "second line",
        splitText,
      );

      const splitEdge = await contentEdge(page, splitId);
      const c2FirstEdge = await contentEdge(page, seeded.c2First);
      r.ok(
        "enter: the new line is a SIBLING of the first child, inside the box",
        splitEdge === c2FirstEdge,
        `first=${c2FirstEdge} new=${splitEdge}`,
      );

      // THE reported bug: Enter minted a second callout, with its own icon.
      const anchorsAfter = await anchorIds(page);
      const minted = anchorsAfter.filter((id) => !anchorsBefore.includes(id));
      r.ok(
        "enter: NO second callout was created (no new decoration appeared)",
        minted.length === 0,
        `minted=${JSON.stringify(minted)}`,
      );
      r.ok(
        "enter: the new line is not itself a callout",
        !anchorsAfter.includes(splitId),
      );

      const probeAfter = await probeFrame(page, seeded.c2, splitId, seeded.c4);
      r.ok(
        "enter: the tint grew to cover the new sibling",
        probeAfter.framed &&
          probeAfter.tint != null &&
          probeAfter.tail != null &&
          probeAfter.tint.bottom >= probeAfter.tail.bottom - 1,
        JSON.stringify(probeAfter.tint),
      );
    }
  } else {
    r.fail("enter: could not place the caret in the callout's first child");
  }

  // --- 7. `/h1` on the first child leaves the container untouched -------------
  // Caret at offset 0, because `atWordBoundary` gates the `/` trigger and index 0
  // is a boundary — so the block's own text survives the conversion.
  if (await caretToStart(page, seeded.c2First)) {
    await page.keyboard.type("/h1", { delay: 40 });
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    await snap(page, out, "4-turned-into-heading");

    const stillThere = await page
      .locator(`[data-block-id="${seeded.c2First}"]`)
      .count();
    r.ok(
      "turn-into: the converted child keeps its block id",
      stillThere === 1,
      `count=${stillThere}`,
    );
    const headingText = await blockText(
      page
        .locator(`[data-block-id="${seeded.c2First}"] [contenteditable="true"]`)
        .first(),
    );
    r.ok(
      "turn-into: its text survived the conversion",
      headingText === "solo line",
      headingText,
    );
    const fontSize = await page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(
        `[data-block-id="${id}"] [contenteditable="true"]`,
      );
      return el ? parseFloat(getComputedStyle(el).fontSize) : -1;
    }, seeded.c2First);
    r.ok(
      "turn-into: it really is a heading now (larger type)",
      fontSize > 20,
      `fontSize=${fontSize}`,
    );

    const anchorsNow = await anchorIds(page);
    r.ok(
      "turn-into: the callout still paints its icon (the container was untouched)",
      anchorsNow.includes(seeded.c2),
      `anchors=${JSON.stringify(anchorsNow)}`,
    );
    const probeH1 = await probeFrame(
      page,
      seeded.c2,
      seeded.c2First,
      seeded.c4,
    );
    r.ok(
      "turn-into: the tint still wraps the converted child",
      probeH1.framed &&
        probeH1.tint != null &&
        probeH1.tail != null &&
        probeH1.tint.bottom >= probeH1.tail.bottom - 1,
      JSON.stringify(probeH1.tint),
    );
  } else {
    r.fail(
      "turn-into: could not place the caret at the start of the first child",
    );
  }

  // --- 8. Tab an EXISTING block into the frame, caret mid-word ----------------
  // This is the load-bearing risk of the whole design: crossing a frame boundary
  // changes the row's DOM PARENT, so React unmounts and remounts its Lexical
  // instance — unlike an ordinary indent, which only reorders keyed siblings in
  // one parent. If the caret does not survive that, the frame is not viable.
  const outsiderEditable = page
    .locator(`[data-block-id="${seeded.outsiderId}"] [contenteditable="true"]`)
    .first();
  const boxOut = await outsiderEditable.boundingBox();
  if (boxOut) {
    // Land the caret in the MIDDLE of "outside", not at an edge — a boundary
    // caret can be restored by a blunt focus() and would hide a real regression.
    await page.mouse.click(boxOut.x + 18, boxOut.y + boxOut.height / 2);
    await page.waitForTimeout(400);
    const before = await caretState(outsiderEditable);
    console.log("caret before Tab:", JSON.stringify(before));

    await page.keyboard.press("Tab");
    await page.waitForTimeout(1200);
    await snap(page, out, "5-tabbed-in");

    const indentedEdge = await contentEdge(page, seeded.outsiderId);
    r.ok(
      "tab-in: the block indented under the callout",
      indentedEdge > c1Edge,
      `callout=${c1Edge} indented=${indentedEdge}`,
    );

    const probeTabbed = await probeFrame(
      page,
      seeded.c1,
      seeded.outsiderId,
      seeded.afterC1,
    );
    r.ok(
      "tab-in: the box grew to cover the block indented into it",
      probeTabbed.framed &&
        !probeTabbed.leaksOutsider &&
        probeTabbed.tint != null &&
        probeTabbed.tail != null &&
        probeTabbed.tint.bottom >= probeTabbed.tail.bottom - 1,
      JSON.stringify(probeTabbed.tint),
    );

    const after = await caretState(outsiderEditable);
    console.log("caret after Tab:", JSON.stringify(after));
    r.ok(
      "tab-in: the caret survived the frame crossing at the SAME offset",
      after.hasSelection === true &&
        after.collapsed === true &&
        after.insideBlock === true &&
        after.anchorOffset === before.anchorOffset,
      `before=${before.anchorOffset} after=${after.anchorOffset}`,
    );

    // Typing proves the live editor (not just the DOM selection) followed.
    await page.keyboard.type("X", { delay: 20 });
    await page.waitForTimeout(1000);
    const typedText = await blockText(outsiderEditable);
    const expected =
      before.anchorOffset != null
        ? `outside`.slice(0, before.anchorOffset) +
          "X" +
          `outside`.slice(before.anchorOffset)
        : null;
    r.ok(
      "tab-in: typing lands at the preserved caret, not at the block start",
      expected != null && typedText === expected,
      `got=${JSON.stringify(typedText)} want=${JSON.stringify(expected)}`,
    );

    // --- Shift+Tab back OUT of the frame -------------------------------------
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(1200);
    await snap(page, out, "6-tabbed-out");

    const outEdge = await contentEdge(page, seeded.outsiderId);
    r.ok(
      "tab-out: the block outdented back out of the callout",
      outEdge <= c1Edge,
      `callout=${c1Edge} outdented=${outEdge}`,
    );
    const probeOut = await probeFrame(
      page,
      seeded.c1,
      seeded.c1First,
      seeded.outsiderId,
    );
    r.ok(
      "tab-out: the box shrank back, leaving the outdented block outside it",
      probeOut.framed && !probeOut.leaksOutsider,
      `framed=${probeOut.framed} leaks=${probeOut.leaksOutsider}`,
    );
    const afterOut = await caretState(outsiderEditable);
    console.log("caret after Shift+Tab:", JSON.stringify(afterOut));
    r.ok(
      "tab-out: the caret survived leaving the frame",
      afterOut.hasSelection === true &&
        afterOut.collapsed === true &&
        afterOut.insideBlock === true,
      JSON.stringify(afterOut),
    );
  } else {
    r.fail("tab-in: the outsider block was not rendered");
  }

  // --- 9. Backspace at the start of the only child UNWRAPS the callout --------
  const anchorsBeforeUnwrap = await anchorIds(page);
  if (await caretToStart(page, seeded.c4Only)) {
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(1500);
    await snap(page, out, "7-unwrapped");

    const survives = await page
      .locator(`[data-block-id="${seeded.c4Only}"]`)
      .count();
    r.ok(
      "unwrap: the child survives — it popped OUT, it was not deleted",
      survives === 1,
    );
    const unwrappedText = await blockText(
      page
        .locator(`[data-block-id="${seeded.c4Only}"] [contenteditable="true"]`)
        .first(),
    );
    r.ok(
      "unwrap: its text is intact",
      unwrappedText === "only child",
      unwrappedText,
    );
    const calloutGone = await page
      .locator(`[data-block-id="${seeded.c4}"]`)
      .count();
    r.ok(
      "unwrap: the callout row is gone",
      calloutGone === 0,
      `count=${calloutGone}`,
    );
    const anchorsAfterUnwrap = await anchorIds(page);
    r.ok(
      "unwrap: its decoration went with it, and no other callout was disturbed",
      anchorsBeforeUnwrap.includes(seeded.c4) &&
        !anchorsAfterUnwrap.includes(seeded.c4) &&
        anchorsBeforeUnwrap
          .filter((id) => id !== seeded.c4)
          .every((id) => anchorsAfterUnwrap.includes(id)),
      `before=${JSON.stringify(anchorsBeforeUnwrap)} after=${JSON.stringify(anchorsAfterUnwrap)}`,
    );
    const endEdge = await contentEdge(page, seeded.end);
    const poppedEdge = await contentEdge(page, seeded.c4Only);
    r.ok(
      "unwrap: the child landed at the callout's own level, not one deeper",
      poppedEdge === endEdge,
      `popped=${poppedEdge} pageLevel=${endEdge}`,
    );
  } else {
    r.fail("unwrap: could not place the caret at the start of the only child");
  }

  // --- 10. convergence in a second context ------------------------------------
  await page.waitForTimeout(2000);
  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await pageB
    .locator(`[data-block-id="${seeded.c1First}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await pageB.waitForTimeout(2500);
  const probeB = await probeFrame(
    pageB,
    seeded.c1,
    seeded.c1First,
    seeded.outsiderId,
  );
  const heightB = await rowHeight(pageB, seeded.c1);
  await snap(pageB, out, "8-context-b");
  console.log("context B:", JSON.stringify({ probeB, heightB }));
  r.ok(
    "converge: a cold load in a second context re-derives the same zero-height anchor + frame",
    heightB === 0 &&
      probeB.framed &&
      !probeB.leaksOutsider &&
      probeB.tint != null &&
      probeB.anchor != null &&
      probeB.tail != null &&
      probeB.tint.top <= probeB.anchor.top + 1 &&
      probeB.tint.bottom >= probeB.tail.bottom - 1,
    `height=${heightB} ${JSON.stringify(probeB.tint)}`,
  );

  console.log("PAGE_URL:", pageUrl);
  await r.finish();
});
