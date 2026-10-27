// The `human` card is a VOID container — the callout's sibling, not its
// opposite. (Its STORED type is still `context`, which is why every payload
// below posts that string: only the directory, the symbol, the label, the corner
// chip and the markdown tag were renamed — see `core/human-notes-block.ts`.)
//
// It shipped once as a TEXT-BEARING collapsible card with an editable title row,
// and that model was rejected: one row played container identity, appearance AND
// the first line of content at once, so Enter in the title minted a second card
// and the card's first visible line could never be a HEADING. The corrected model
// is the callout's — `anchor: true`, `wrapOnConvert: true`, payload
// `z.object({})` with NO `text`. The card renders no line of its own; its
// entire displayed content is its children, ordinary blocks of any type that do
// not know they are inside it. It is still collapsible: it folds to its BORROWED
// line, which is `page/container`'s behaviour and is specced in that plugin's
// `e2e/container-collapse-verify.ts`.
//
// Every claim below is invisible to a unit test of the pure grouping — a frame is
// a `pointer-events-none` SIBLING backdrop spanning grid lines, never an ancestor
// of the rows (wrapping them would remount a block's Lexical instance whenever it
// crossed the boundary) — so all of it is asserted against live rects on the real
// editable surface.
//
//  1. THE VOID SCHEMA IS ENFORCED AT THE WRITE BOUNDARY. A `context` payload
//     carrying a `text` key is REJECTED (`parseBlockData`'s top-level `.strict()`
//     ⇒ loud 400), while `{}` is accepted. The direct inverse of the old spec's
//     first assertion, and what proves the void model is real rather than
//     aspirational: `acceptsText` is *derived* from the schema, so a stray `text`
//     surviving the boundary would mean the card is still text-bearing whatever
//     the handle claims. The 400 is checked for its REASON too — an unregistered
//     block type 400s here as well, and would otherwise pass this trivially.
//  2. NO LINE OF ITS OWN. The card's row measures ~0px high with visible children,
//     and renders NO `contenteditable` at all. That is what puts its gutter
//     decoration and its first child on ONE visual line, and it is the precise
//     DOM-level death of the rejected title row.
//  3. CHILDLESS CARD IS A VISIBLE, HIT-TESTABLE ONE-LINE BOX. `computeFrameSpans`
//     spans a childless container over its own row alone; at zero height that
//     would paint a 0px frame over a 0px row — an invisible, unclickable,
//     undeletable ghost — so the row falls back to one empty line. Asserted FIRST,
//     deliberately: `pruneEmptyAnchors` is a forest-wide post-pass on
//     `applyBlockOp`, so the very next structural keystroke on this page dissolves
//     it (exactly as in the callout spec, for exactly the same reason).
//  4. THE USER'S ACTUAL COMPLAINT: THE FIRST VISIBLE LINE CAN BE A HEADING. A card
//     whose first child is a `heading-1` still paints its box around it, the
//     heading still renders as a heading, and the topmost line inside the box IS
//     that heading. Structurally impossible under the text-bearing model, where
//     the first line was the container's own title row. The highest-value
//     assertion in this file.
//  5. ENTER INSIDE A CHILD YIELDS A SIBLING INSIDE THE BOX. Exactly one new line,
//     a child of the SAME container, and NO second container box. The regression
//     the user reported — under the old model another content line meant another
//     container.
//  6. BACKSPACE AT THE START OF THE FIRST CHILD UNWRAPS. The container dissolves
//     and ALL its children are promoted into its slot (the `unwrap` op) — box
//     gone, content kept, nothing re-nested. Distinct from Delete, which removes
//     the container WITH its subtree. The generic `isIndented` → outdent rung
//     would pop the first child out and adopt its remaining siblings as ITS
//     children, which is why this rung exists at all.
//  7. `/human` ON AN EXISTING BLOCK WRAPS IT (`wrapOnConvert: true`): the origin
//     keeps its id, type, `data` and children and becomes the card's first child;
//     a brand-new row is minted for the anchor. Keeping the origin's id is the
//     load-bearing part — its content `Y.Doc`, its owner and its registered
//     focus handle are ALL keyed by block id.
//  8. NESTING: a `human` card as the MIDDLE child of a `callout` paints BOTH
//     boxes, the callout's strictly containing the card's (above and below, one
//     indent shallower) rather than partially overlapping it.
//  9. CONVERGE in a SECOND browser context (fresh socket, cold load): the wrap and
//     the Enter-minted child are persisted structure, not view state.
//
// Two measurement conventions, both load-bearing:
//
// - A box is matched to the block that OWNS it by its top edge AND its left
//   edge, both read off that block's own row. Paint says nothing about ownership
//   any more: a human card used to be told from a callout by its DASHED
//   border, and no box is dashed now — every container paints a soft tint and
//   nothing else. The left edge replaces it and is true by construction, because
//   a frame paints its own CONTENT box: its left edge is its row's content edge
//   plus one `BLOCK_INSET`, so a card nested in a callout starts exactly one
//   `BLOCK_INDENT` to the right of the callout's box. That is what keeps the two
//   apart in the case where the tops coincide — a card that is a callout's FIRST
//   child shares its box top with the callout's own, both anchor rows being
//   zero-height at the same y. Still not by any decoration selector: the anchor's
//   own control is this plugin's business, and a spec that named it would fail
//   for a cosmetic rename rather than for a regression.
// - Rects answer "what does the user see"; the blocks API answers "what is the
//   structure". Identity, type, and parentage claims (#6, #7) read
//   `GET /api/pages/:pageId/blocks` — a content edge one indent deeper is
//   evidence of nesting, not proof of a `parentId`.
//
// Usage: bun plugins/page/plugins/annotations/plugins/human-notes/e2e/human-notes-container-verify.ts [--url <deploy>] [--out /tmp/human-notes]
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

const out = arg("out", "/tmp/human-notes");

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
  right: number;
  height: number;
}

interface RowRect {
  top: number;
  bottom: number;
  left: number;
  height: number;
  /** The row's content edge — one BLOCK_INDENT deeper per nesting level. */
  contentLeft: number;
  /**
   * Where this row's own TEXT starts, or `null` for a row with no editable of
   * its own. For a marker-less row this is its content edge plus exactly one
   * `BLOCK_INSET` — which is also where a container box painted at this depth
   * begins.
   */
  textLeft: number | null;
  /** Does this row own an editable surface? A void anchor row must not. */
  editable: boolean;
}

interface Geometry {
  /** Every painted container backdrop currently on the block grid. */
  boxes: FrameBox[];
  /** Every rendered row, by block id — absent when the block is not in the DOM. */
  rows: Record<string, RowRect | undefined>;
  /** Every block id in document order. */
  order: string[];
  /**
   * One `BLOCK_INSET` in px, MEASURED off an ordinary paragraph: the gap between
   * where a row's box is measured from (its content edge) and where its first
   * glyph lands. It is the same step a container's box takes from its own row's
   * content edge, which is what makes a box's left edge identify its owner.
   *
   * Never hardcoded — `BLOCK_INSET` is the `--space-md` token, so it moves with
   * the density preset and 12px is only today's answer at today's default.
   * `null` if the yardstick row was not on the page.
   */
  inset: number | null;
}

/**
 * Read the surface's geometry straight off the DOM, in one pass.
 *
 * Frames are SIBLING backdrops placed on the block grid by line number, never
 * ancestors of the rows they cover, so DOM ancestry would say nothing about
 * whether a box is in the right place. What a user sees is a painted rectangle
 * over a set of rows, and that is what this measures.
 *
 * The browser side only MEASURES — every "which box belongs to which block"
 * decision is made in the helpers below, where it stays readable. Measuring
 * EVERY row (rather than a requested id list) is what lets a box's owner be
 * resolved generically, without the script having to guess the answer first.
 *
 * `insetRowId` names the yardstick: an ordinary, marker-less, page-level
 * paragraph off which one `BLOCK_INSET` is read (see `Geometry.inset`).
 */
async function geometry(page: Page, insetRowId: string): Promise<Geometry> {
  return page.evaluate((insetRowId: string) => {
    const rows: Record<string, RowRect> = {};
    const order: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(
      "[data-block-id]",
    )) {
      const id = el.getAttribute("data-block-id");
      if (id === null) continue;
      order.push(id);
      const rect = el.getBoundingClientRect();
      const editable = el.querySelector<HTMLElement>(
        '[contenteditable="true"]',
      );
      rows[id] = {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        height: rect.height,
        contentLeft:
          rect.left + parseFloat(getComputedStyle(el).paddingLeft || "0"),
        textLeft: editable ? editable.getBoundingClientRect().left : null,
        editable: editable !== null,
      };
    }
    const yardstick = rows[insetRowId];
    const inset =
      yardstick && yardstick.textLeft !== null
        ? yardstick.textLeft - yardstick.contentLeft
        : null;

    // Rows sit one wrapper deep in the block grid (each row wrapper is placed on
    // its own grid line); the frames are siblings of those wrappers, holding no
    // rows of their own — which is exactly how they are told apart here.
    const anyRow = document.querySelector<HTMLElement>("[data-block-id]");
    const grid = anyRow?.parentElement?.parentElement;
    const boxes: FrameBox[] = [];
    for (const child of grid ? [...grid.children] : []) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.querySelector("[data-block-id]") !== null) continue;
      // The frame WRAPPER only positions; the contribution inside it does the
      // painting. Take the first node in the subtree that actually paints — a
      // background OR a border. Every container box is a soft tint and nothing
      // else now, but the search still admits a border so that a box which grew
      // one is FOUND (and measured, and matched to its owner) rather than going
      // silently missing.
      for (const node of [
        child,
        ...child.querySelectorAll<HTMLElement>("div"),
      ]) {
        const style = getComputedStyle(node);
        const bg = style.backgroundColor;
        const filled =
          bg !== "" &&
          bg !== "transparent" &&
          !bg.startsWith("rgba(0, 0, 0, 0)");
        const bordered =
          style.borderTopStyle !== "none" &&
          parseFloat(style.borderTopWidth || "0") > 0;
        if (!filled && !bordered) continue;
        const box = node.getBoundingClientRect();
        boxes.push({
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
          height: box.height,
        });
        break;
      }
    }
    return { boxes, rows, order, inset };
  }, insetRowId);
}

/**
 * Where the box a block at this row would paint STARTS — its content edge plus
 * one `BLOCK_INSET`, which is the whole of the container-box left-edge rule.
 */
function boxLeftFor(g: Geometry, row: RowRect): number | null {
  return g.inset === null ? null : row.contentLeft + g.inset;
}

/**
 * Does this box belong to the block on this row? Top edge AND left edge.
 *
 * Geometry rather than DOM position, and edges rather than containment, because
 * containment is ambiguous the moment containers nest: an enclosing callout's
 * tint also covers a nested card's rows.
 *
 * The TOP alone is not enough either. A frame starts on its container's own grid
 * line, and a container's anchor row is zero height — so a card that is a
 * callout's FIRST child shares its box top with the callout's own box exactly.
 * This used to be settled by asking whether the border was DASHED; no box is
 * dashed now, every container painting a soft tint and nothing else.
 *
 * The LEFT edge replaces it and is true by construction rather than by
 * convention: a frame paints its own CONTENT box, so its left edge is its row's
 * content edge plus one `BLOCK_INSET`. A nested card's row is one `BLOCK_INDENT`
 * deeper than its callout's, so its box starts 24px to the right — a gap no
 * repaint can close while the card is still nested.
 */
function ownsBox(g: Geometry, row: RowRect, box: FrameBox): boolean {
  const left = boxLeftFor(g, row);
  return (
    left !== null &&
    Math.abs(box.top - row.top) <= 1 &&
    Math.abs(box.left - left) <= 1
  );
}

/** The frame box a given block OWNS, by both its edges. */
function boxOwnedBy(g: Geometry, blockId: string): FrameBox | undefined {
  const row = g.rows[blockId];
  if (!row) return undefined;
  return g.boxes.find((b) => ownsBox(g, row, b));
}

/** The human card's soft-tinted box for this block, if it paints one. */
function cardBox(g: Geometry, blockId: string): FrameBox | undefined {
  return boxOwnedBy(g, blockId);
}

/**
 * The callout's tint for this block, if it paints one.
 *
 * The same lookup as `cardBox` — deliberately, and this is the point of the new
 * discriminator. Which KIND of container a box belongs to is now answered by
 * whose row it starts on, not by how it is painted, so there is one resolution
 * and the two names say only which container the caller is asking about.
 */
function tintBox(g: Geometry, blockId: string): FrameBox | undefined {
  return boxOwnedBy(g, blockId);
}

/** The earliest row in document order that owns this box, by both its edges. */
function ownerOf(g: Geometry, box: FrameBox): string | undefined {
  return g.order.find((id) => {
    const row = g.rows[id];
    return row != null && ownsBox(g, row, box);
  });
}

/**
 * The block ids of every row currently OWNING a container box — the cards AND
 * the seeded callout, since a box's paint no longer says which it is.
 *
 * That is a wider set than the old dashed-only one, and strictly stronger for
 * every use below: "no new box appeared" now also catches a stray callout, and
 * "this card's box went with it" still names one id.
 *
 * A SET, not a count, deliberately — the same reasoning as the callout spec's
 * decoration set: `pruneEmptyAnchors` is a forest-wide post-pass, so any
 * structural op may legitimately REMOVE a childless card elsewhere on the page
 * (and this fixture seeds one on purpose). "Enter did not mint a second card" is
 * therefore "no NEW id appeared", which a count would conflate with that prune.
 *
 * The owner is resolved as the FIRST row matching the box on BOTH edges: a void
 * anchor row is zero height and precedes its first child in document order, so
 * the two share a y — and the child's row is one indent deeper, so only the
 * anchor's own left edge agrees.
 */
function boxOwners(g: Geometry): string[] {
  return g.boxes
    .map((b) => ownerOf(g, b))
    .filter((id): id is string => id !== undefined);
}

/** The topmost VISIBLE line (non-zero-height row) painted inside a box. */
function firstLineInside(g: Geometry, box: FrameBox): string | undefined {
  return g.order.find((id) => {
    const row = g.rows[id];
    return (
      row != null &&
      row.height > 1 &&
      row.top >= box.top - 1 &&
      row.bottom <= box.bottom + 1
    );
  });
}

/** A block's rendered text, read off its own editable surface. */
async function textOf(page: Page, blockId: string): Promise<string> {
  return blockText(
    page
      .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
      .first(),
  );
}

/** A block's rendered font size — how "is it really a heading" is measured. */
async function fontSizeOf(page: Page, blockId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(
      `[data-block-id="${id}"] [contenteditable="true"]`,
    );
    return el ? parseFloat(getComputedStyle(el).fontSize) : -1;
  }, blockId);
}

interface StoredRow {
  id: string;
  parentId: string | null;
  type: string;
}

/**
 * The persisted forest, straight from the blocks endpoint.
 *
 * Rects prove what is painted; only this proves the STRUCTURE — that the origin
 * of a wrap kept its `type` and its children, and that an unwrapped child really
 * landed in the container's slot rather than merely rendering at that indent.
 */
async function storedRows(page: Page, pageId: string): Promise<StoredRow[]> {
  const res = await pageFetch(page, `/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`GET blocks ${res.status}: ${await res.text()}`);
  return (await res.json()) as StoredRow[];
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

interface SeedIds {
  /** Card whose FIRST CHILD IS A HEADING — the user's actual complaint. */
  card: string;
  cardHead: string;
  cardMid: string;
  cardTail: string;
  /** The block after `card`: the box must never reach it. */
  outsider: string;
  /** Childless card — the visible-one-line-box subject. */
  empty: string;
  /** Card with one child, at whose end Enter is pressed. */
  enterCard: string;
  enterChild: string;
  /** Card with TWO children — Backspace at the first one's start unwraps. */
  unwrapCard: string;
  unwrapFirst: string;
  unwrapSecond: string;
  /** A plain text block WITH A CHILD, wrapped by `/human`. */
  wrapMe: string;
  wrapKid: string;
  /** callout > [text, human card > text, text] — the nesting subject. */
  callout: string;
  calloutHead: string;
  nested: string;
  nestedChild: string;
  calloutTail: string;
  end: string;
}

/** The write boundary's verdict on one `POST /api/blocks` body. */
interface PostProbe {
  status: number;
  body: string;
}

/**
 * Post a `context` payload and report the boundary's verdict verbatim, without
 * throwing — assertion #1 is about a REJECTION, so the failure path is the
 * measurement, not an error.
 */
async function probePost(
  page: Page,
  pageId: string,
  data: unknown,
): Promise<PostProbe> {
  const res = await pageFetch(page, "/api/blocks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentId: pageId, type: "context", data }),
  });
  return { status: res.status, body: await res.text() };
}

/** Hard-delete one block subtree. Throws loudly — a failed cleanup is a fixture lie. */
async function deleteBlock(page: Page, blockId: string): Promise<void> {
  const response = await pageFetch(page, `/api/blocks/${blockId}`, {
    method: "DELETE",
  });
  const res = { status: response.status, body: await response.text() };
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DELETE /api/blocks/${blockId} ${res.status}: ${res.body}`);
  }
}

/**
 * Seed the fixture through `POST /api/blocks` and let a cold load re-derive
 * everything from persisted rows — no keystroke has run yet, so nothing measured
 * afterwards can be an artifact of the composing flow.
 *
 * Every `context` payload here is `{}`. A card is VOID: its content is its
 * children, and a seed that posted `{text: […]}` — as this script's predecessor
 * did — is itself the regression this file exists to catch.
 */
async function seedCards(page: Page, pageId: string): Promise<SeedIds> {
  const parent = pageId;
  const post = async (body: unknown): Promise<{ id: string }> => {
    const res = await pageFetch(page, "/api/blocks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`POST /api/blocks ${res.status}: ${await res.text()}`);
    return (await res.json()) as { id: string };
  };
  const humanCard = (parentId: string) =>
    post({ parentId, type: "context", data: {} });
  const text = (parentId: string, type: string, body: string) =>
    post({ parentId, type, data: { text: [{ text: body }] } });

      const card = await humanCard(parent);
      const cardHead = await text(card.id, "heading-1", "Repo conventions");
      const cardMid = await text(card.id, "text", "always run build");
      const cardTail = await text(card.id, "bulleted-list", "never poll");
      const outsider = await text(parent, "text", "outside the card");

      const empty = await humanCard(parent);

      const enterCard = await humanCard(parent);
      // A plain `text` child: the Enter under test must be an ordinary sibling
      // split, not a marker-bearing block's own behaviour.
      const enterChild = await text(enterCard.id, "text", "solo line");

      const unwrapCard = await humanCard(parent);
      // `text` again, deliberately: Backspace's ladder strips a MARKER GLYPH first,
      // so a bulleted first child would convert before it ever reached `unwrap`.
      const unwrapFirst = await text(unwrapCard.id, "text", "first inside");
      const unwrapSecond = await text(
        unwrapCard.id,
        "bulleted-list",
        "second inside",
      );

      // The wrap subject carries a CHILD: "the origin keeps its children" is the
      // half of `wrapOnConvert` that a childless origin cannot show.
      const wrapMe = await text(parent, "text", "wrap me");
      const wrapKid = await text(wrapMe.id, "bulleted-list", "kid");

      const callout = await post({
        parentId: parent,
        type: "callout",
        data: { icon: null, color: "info" },
      });
      const calloutHead = await text(callout.id, "text", "callout head");
      const nested = await humanCard(callout.id);
      const nestedChild = await text(nested.id, "text", "inner line");
      const calloutTail = await text(callout.id, "text", "callout tail");

      const end = await text(parent, "text", "the end");

      return {
        card: card.id,
        cardHead: cardHead.id,
        cardMid: cardMid.id,
        cardTail: cardTail.id,
        outsider: outsider.id,
        empty: empty.id,
        enterCard: enterCard.id,
        enterChild: enterChild.id,
        unwrapCard: unwrapCard.id,
        unwrapFirst: unwrapFirst.id,
        unwrapSecond: unwrapSecond.id,
        wrapMe: wrapMe.id,
        wrapKid: wrapKid.id,
        callout: callout.id,
        calloutHead: calloutHead.id,
        nested: nested.id,
        nestedChild: nestedChild.id,
        calloutTail: calloutTail.id,
        end: end.id,
  };
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const { pageUrl, pageId } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);

  // --- 1. the VOID schema is enforced at the write boundary -------------------
  // `parseBlockData` parses `handle.schema.strict()`, so an unknown top-level key
  // is a loud 400 rather than a silent strip. With `acceptsText` derived from the
  // schema, this single request is what separates "the card is void" from "the
  // handle says the card is void".
  //
  // The REASON matters: an unregistered block type ALSO 400s here
  // (`resolveBlockHandle` → "Unknown block type"), so a bare status check would
  // pass on a page where `context` does not exist at all. The accepted `{}` below
  // is the other half of the pincer and is what carries that proof; the message
  // assertion is corroboration, and its wording is zod's, so it is the one line
  // here that a dependency bump could legitimately move.
  const withText = await probePost(page, pageId, {
    text: [{ text: "not allowed" }],
  });
  console.log("void-schema probe:", JSON.stringify(withText));
  r.ok(
    "void schema: a `context` payload carrying `text` is REJECTED (400)",
    withText.status === 400,
    `status=${withText.status} body=${withText.body}`,
  );
  r.ok(
    "void schema: rejected as an UNRECOGNIZED KEY on a registered type, not as an unknown type",
    withText.status === 400 &&
      /Invalid data for block type "context"/.test(withText.body) &&
      /Unrecognized key/.test(withText.body),
    withText.body,
  );

  const withEmpty = await probePost(page, pageId, {});
  const accepted = withEmpty.status >= 200 && withEmpty.status < 300;
  r.ok(
    "void schema: the empty payload `{}` is ACCEPTED — the type is registered and truly void",
    accepted,
    `status=${withEmpty.status} body=${withEmpty.body}`,
  );
  if (accepted) {
    // Delete the probe row before the fixture is seeded. It is a real childless
    // card: left on the page it would add a sixth box to every count below, and a
    // stray prune target to the first structural keystroke.
    const probeId = (JSON.parse(withEmpty.body) as { id?: string }).id;
    if (probeId === undefined) {
      r.fail(
        "void schema: the accepted probe returned a block row",
        withEmpty.body,
      );
    } else {
      await deleteBlock(page, probeId);
    }
  }

  // --- seed ------------------------------------------------------------------
  const seeded = await seedCards(page, pageId).catch(
    (err: unknown): Promise<never> =>
      bail(
        "seed: the fixture posts through the write boundary",
        `${err instanceof Error ? err.message : String(err)} — nothing below is checkable`,
      ),
  );
  console.log("seeded:", JSON.stringify(seeded));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(`[data-block-id="${seeded.end}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "1-seeded");

  const g0 = await geometry(page, seeded.end);
  const ownersSeeded = boxOwners(g0);
  console.log("card owners:", JSON.stringify(ownersSeeded));

  const cardRow0 = g0.rows[seeded.card];
  const headRow0 = g0.rows[seeded.cardHead];
  const tailRow0 = g0.rows[seeded.cardTail];
  const outsiderRow0 = g0.rows[seeded.outsider];
  if (!cardRow0 || !headRow0 || !tailRow0 || !outsiderRow0) {
    return await bail(
      "seed: the card, its heading + last child, and the following block all rendered",
      JSON.stringify({ cardRow0, headRow0, tailRow0, outsiderRow0 }),
    );
  }
  r.ok(
    "seed: the children are NESTED inside the card (one indent deeper)",
    headRow0.contentLeft > cardRow0.contentLeft,
    `card=${cardRow0.contentLeft} child=${headRow0.contentLeft}`,
  );

  // --- 2. the card renders NO line of its own --------------------------------
  // Zero height is what puts the card's gutter decoration and its first child on
  // one visual line. The `editable` half is the rejected model's death
  // certificate: a title row would own a `contenteditable`, and the whole class
  // of bug it caused (Enter minting a card, converting the line destroying the
  // box) is unreachable only while this row holds no text of its own.
  r.ok(
    "void row: the card's row collapses to zero height while it has visible children",
    cardRow0.height === 0,
    `height=${cardRow0.height}`,
  );
  r.ok(
    "void row: the card's row owns NO editable surface (there is no title row)",
    cardRow0.editable === false,
  );

  // --- 3. a childless card is a REAL, VISIBLE, HIT-TESTABLE box ---------------
  // FIRST, before any structural keystroke: `pruneEmptyAnchors` is a forest-wide
  // post-pass on every `applyBlockOp`, so the Enter in step 5 dissolves this card.
  // `computeFrameSpans` deliberately spans a childless container over its own row
  // alone, and at zero height that is a 0px frame over a 0px row — invisible,
  // unclickable, undeletable. The row therefore falls back to one empty line.
  const emptyRow0 = g0.rows[seeded.empty];
  const emptyBox0 = cardBox(g0, seeded.empty);
  console.log(
    "childless card:",
    JSON.stringify({ row: emptyRow0, box: emptyBox0 }),
  );
  if (!emptyRow0) {
    r.fail("childless: the empty card rendered a row at all");
  } else {
    r.ok(
      "childless: the row falls back to a real one-line box (not the 0px anchor row)",
      emptyRow0.height > 12,
      `height=${emptyRow0.height}`,
    );
    r.ok(
      "childless: that line is as tall as a plain text row",
      Math.abs(emptyRow0.height - outsiderRow0.height) <= 2,
      `card=${emptyRow0.height} text=${outsiderRow0.height}`,
    );
    r.ok(
      "childless: a visible box is painted over it (not a 0px ghost)",
      emptyBox0 != null && emptyBox0.height > 12,
      JSON.stringify(emptyBox0),
    );
    r.ok(
      "childless: that box covers its own row and nothing below it",
      emptyBox0 != null &&
        emptyBox0.top <= emptyRow0.top + 1 &&
        emptyBox0.bottom >= emptyRow0.bottom - 1 &&
        emptyBox0.bottom <= emptyRow0.bottom + 2,
      `box=${JSON.stringify(emptyBox0)} row=${JSON.stringify(emptyRow0)}`,
    );
    // Clickability, hit-tested rather than inferred from the rect: frames are
    // `pointer-events-none`, so a point inside this box must resolve to the CARD'S
    // OWN ROW. If it resolved to a neighbour (or to nothing), the empty card would
    // be undeletable however tall its rect claims to be.
    const hit = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest("[data-block-id]")
          ?.getAttribute("data-block-id") ?? null,
      {
        x: emptyRow0.contentLeft + 20,
        y: emptyRow0.top + emptyRow0.height / 2,
      },
    );
    r.ok(
      "childless: a click inside the box lands on the card's own row (a live target)",
      hit === seeded.empty,
      `hit=${String(hit)} want=${seeded.empty}`,
    );
  }

  // --- 4. THE USER'S COMPLAINT: the first visible line can be a HEADING -------
  // Under the text-bearing model this was structurally impossible: the card's own
  // title row was always the first line, so a heading could only ever be the
  // SECOND. Now the card owns no line, the heading is an ordinary `heading-1`
  // child, and the box is painted around it — the single most important thing
  // this rewrite buys.
  const box0 = cardBox(g0, seeded.card);
  console.log("card box:", JSON.stringify(box0));
  if (!box0) {
    r.fail(
      "heading-first: the card paints a soft-tinted box owned by its own (zero-height) row",
      `boxes=${JSON.stringify(g0.boxes)} cardTop=${cardRow0.top} inset=${String(g0.inset)}`,
    );
  } else {
    r.ok(
      "heading-first: the box starts on the card's own row",
      box0.top <= cardRow0.top + 1,
      `box.top=${box0.top} card.top=${cardRow0.top}`,
    );
    r.ok(
      "heading-first: the topmost VISIBLE line inside the box IS the heading",
      firstLineInside(g0, box0) === seeded.cardHead,
      `first=${String(firstLineInside(g0, box0))} want=${seeded.cardHead}`,
    );
    r.ok(
      "heading-first: the heading really renders as a heading (larger type)",
      (await fontSizeOf(page, seeded.cardHead)) > 20,
      `fontSize=${await fontSizeOf(page, seeded.cardHead)}`,
    );
    r.ok(
      "heading-first: the heading's own text is intact",
      (await textOf(page, seeded.cardHead)) === "Repo conventions",
      await textOf(page, seeded.cardHead),
    );
    // A container, not a decorated single row: the box must span the whole visible
    // subtree. "A box exists over the heading" would pass for a block type that
    // merely styles its own row.
    r.ok(
      "heading-first: the box extends PAST the heading — it spans the subtree",
      box0.bottom > headRow0.bottom + 1,
      `box.bottom=${box0.bottom} heading.bottom=${headRow0.bottom}`,
    );
    r.ok(
      "heading-first: the box reaches the card's LAST visible descendant",
      box0.bottom >= tailRow0.bottom - 1,
      `box.bottom=${box0.bottom} last.bottom=${tailRow0.bottom}`,
    );
    r.ok(
      "heading-first: the box stops before the block AFTER the card (no leak)",
      box0.bottom <= outsiderRow0.top + 1,
      `box.bottom=${box0.bottom} outsider.top=${outsiderRow0.top}`,
    );
    // The card paints its own CONTENT box, so its left edge lands on the same x
    // as the first letter of the ordinary paragraph right after it — same depth,
    // same edge. It used to start one `BLOCK_INSET` further left, at the
    // decoration origin `C`, which made the card the one decorated box on the
    // page that did not line up with the prose. Measured against that
    // paragraph's real glyph line, never a hardcoded 12px.
    r.ok(
      "heading-first: the box's left edge lines up with the TEXT of the paragraph after it",
      outsiderRow0.textLeft !== null &&
        Math.abs(box0.left - outsiderRow0.textLeft) <= 1,
      `box.left=${box0.left} outsiderTextLeft=${String(outsiderRow0.textLeft)} contentEdge=${cardRow0.contentLeft}`,
    );
  }

  // --- 8. nesting: a card inside a callout ------------------------------------
  // Read-only, so it runs BEFORE any keystroke — every structural op below moves
  // rows and would invalidate these coordinates.
  //
  // The card is the callout's MIDDLE child on purpose: with a sibling text line
  // above and below it, "the callout's box contains the card's" is a strict
  // containment on both edges rather than a coincidence of shared edges. Both
  // containers are now anchors, so both boxes start on a zero-height row — and
  // both are painted the same way, a soft tint and no border, so it is each
  // box's LEFT edge that says which row owns it (`ownsBox`).
  const nestedRow0 = g0.rows[seeded.nested];
  const calloutRow0 = g0.rows[seeded.callout];
  const outerBox = calloutRow0 ? tintBox(g0, seeded.callout) : undefined;
  const innerBox = nestedRow0 ? cardBox(g0, seeded.nested) : undefined;
  console.log("nesting:", JSON.stringify({ outerBox, innerBox }));
  r.ok(
    "nesting: BOTH the callout's tint and the nested card's own box are painted",
    outerBox != null && innerBox != null,
    JSON.stringify({ outerBox, innerBox, boxes: g0.boxes }),
  );
  if (!outerBox || !innerBox || !nestedRow0 || !calloutRow0) {
    r.fail(
      "nesting: the callout row, the nested card row and both boxes all resolved",
      JSON.stringify({ outerBox, innerBox, nestedRow0, calloutRow0 }),
    );
  } else {
    r.ok(
      "nesting: the card's box NESTS inside the callout's — contained above and below, never partially overlapping",
      outerBox.top <= innerBox.top + 1 &&
        outerBox.bottom >= innerBox.bottom - 1,
      `outer=[${outerBox.top},${outerBox.bottom}] inner=[${innerBox.top},${innerBox.bottom}]`,
    );
    r.ok(
      "nesting: the containment is STRICT (the callout has content above and below the card)",
      outerBox.top < innerBox.top - 1 && outerBox.bottom > innerBox.bottom + 1,
      `outer=[${outerBox.top},${outerBox.bottom}] inner=[${innerBox.top},${innerBox.bottom}]`,
    );
    // Exactly one BLOCK_INDENT, not merely "further right": each frame paints
    // its OWN content box, so the gap between the two boxes is the gap between
    // the two rows' content edges and nothing else. This is the fact the
    // ownership rule rests on, so it is asserted as an equality.
    r.ok(
      "nesting: the inner box starts exactly one indent right of the outer one (each frame paints its OWN content box)",
      Math.abs(
        innerBox.left -
          outerBox.left -
          (nestedRow0.contentLeft - calloutRow0.contentLeft),
      ) <= 1,
      `outer.left=${outerBox.left} inner.left=${innerBox.left} indent=${nestedRow0.contentLeft - calloutRow0.contentLeft}`,
    );
    r.ok(
      "nesting: the nested card's own box still spans its child",
      innerBox.bottom >= (g0.rows[seeded.nestedChild]?.bottom ?? Infinity) - 1,
      `inner.bottom=${innerBox.bottom} child.bottom=${g0.rows[seeded.nestedChild]?.bottom}`,
    );
  }

  // Six, not five: the seeded callout paints a box too, and it is no longer
  // distinguishable by paint from the five cards — so it is counted with them.
  // That is the stronger claim, not the weaker one: a stray box anywhere on the
  // page now fails this, whichever container type minted it.
  r.ok(
    "seed: exactly the five seeded cards and the one callout paint a box — six, no more",
    ownersSeeded.length === 6,
    `owners=${JSON.stringify(ownersSeeded)}`,
  );
  r.ok(
    "seed: each box is owned by its own container's row (no box orphaned onto a child)",
    [
      seeded.card,
      seeded.empty,
      seeded.enterCard,
      seeded.unwrapCard,
      seeded.nested,
      seeded.callout,
    ].every((id) => ownersSeeded.includes(id)),
    `owners=${JSON.stringify(ownersSeeded)}`,
  );

  // --- 5. Enter inside a child yields a SIBLING inside the box ----------------
  // THE reported regression: pressing Enter minted a second card, because under
  // the text-bearing model another line of content meant another container. Now
  // the child is an ordinary block and Enter is an ordinary sibling split — there
  // is no card-specific keystroke handling to get this wrong.
  const ownersBeforeEnter = boxOwners(g0);
  const orderBeforeEnter = g0.order;
  if (!(await caretToEnd(page, seeded.enterChild))) {
    r.fail("enter: could not place the caret at the end of the card's child");
  } else {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    await page.keyboard.type("second line", { delay: 25 });
    await page.waitForTimeout(2000);
    await snap(page, out, "2-enter-sibling");

    const gEnter = await geometry(page, seeded.end);
    const minted = gEnter.order.filter((id) => !orderBeforeEnter.includes(id));
    console.log("minted ids:", JSON.stringify(minted));
    r.ok(
      "enter: exactly one new line was created",
      minted.length === 1,
      JSON.stringify(minted),
    );

    const newId = minted[0];
    if (newId === undefined) {
      r.fail("enter: no new block to inspect");
    } else {
      const newRow = gEnter.rows[newId];
      const childRow = gEnter.rows[seeded.enterChild];
      r.ok(
        "enter: typing landed in the new line",
        (await textOf(page, newId)) === "second line",
        await textOf(page, newId),
      );
      r.ok(
        "enter: the original child kept its own text (the split took the tail)",
        (await textOf(page, seeded.enterChild)) === "solo line",
        await textOf(page, seeded.enterChild),
      );
      r.ok(
        "enter: the new line is a SIBLING of that child, at the same depth inside the box",
        newRow != null &&
          childRow != null &&
          newRow.contentLeft === childRow.contentLeft,
        `child=${childRow?.contentLeft} new=${newRow?.contentLeft}`,
      );
      r.ok(
        "enter: it sits immediately after that child in document order",
        gEnter.order.indexOf(newId) ===
          gEnter.order.indexOf(seeded.enterChild) + 1,
        `order=${JSON.stringify(gEnter.order.slice(Math.max(0, gEnter.order.indexOf(seeded.enterChild) - 1)))}`,
      );
      // A SET difference, not a count: this same keystroke legitimately prunes the
      // childless card seeded for step 3.
      const ownersAfterEnter = boxOwners(gEnter);
      const newCards = ownersAfterEnter.filter(
        (id) => !ownersBeforeEnter.includes(id),
      );
      r.ok(
        "enter: NO second container was minted (no new box appeared, of any container type)",
        newCards.length === 0,
        `new=${JSON.stringify(newCards)} owners=${JSON.stringify(ownersAfterEnter)}`,
      );
      r.ok(
        "enter: the new line is not itself a card (it owns no box)",
        cardBox(gEnter, newId) === undefined &&
          !ownersAfterEnter.includes(newId),
        JSON.stringify(cardBox(gEnter, newId)),
      );
      const grownBox = cardBox(gEnter, seeded.enterCard);
      r.ok(
        "enter: the card's box GREW to cover its new child",
        grownBox != null &&
          newRow != null &&
          grownBox.bottom >= newRow.bottom - 1,
        `box=${JSON.stringify(grownBox)} newRow=${JSON.stringify(newRow)}`,
      );

      // --- 6. Backspace at the start of the FIRST child UNWRAPS --------------
      // The one card-shaped rung in the generic keystroke ladder. The generic
      // `isIndented` → outdent rung would pop the first child out and ADOPT its
      // remaining siblings as its children — silently re-nesting content nobody
      // asked to nest — which is precisely why `unwrap` exists. Distinct from
      // Delete, which removes the container WITH its subtree: here the box goes
      // and every line survives, at the card's own level.
      const ownersBeforeUnwrap = boxOwners(gEnter);
      if (!(await caretToStart(page, seeded.unwrapFirst))) {
        r.fail(
          "unwrap: could not place the caret at the start of the first child",
        );
      } else {
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(1800);
        await snap(page, out, "3-unwrapped");

        const gUnwrap = await geometry(page, seeded.end);
        r.ok(
          "unwrap: the card's row is gone",
          gUnwrap.rows[seeded.unwrapCard] === undefined,
          JSON.stringify(gUnwrap.rows[seeded.unwrapCard]),
        );
        r.ok(
          "unwrap: its tinted box went with it, and no other container was disturbed",
          ownersBeforeUnwrap.includes(seeded.unwrapCard) &&
            !boxOwners(gUnwrap).includes(seeded.unwrapCard) &&
            ownersBeforeUnwrap
              .filter((id) => id !== seeded.unwrapCard)
              .every((id) => boxOwners(gUnwrap).includes(id)),
          `before=${JSON.stringify(ownersBeforeUnwrap)} after=${JSON.stringify(boxOwners(gUnwrap))}`,
        );
        r.ok(
          "unwrap: BOTH children survive — they were promoted, not deleted",
          gUnwrap.rows[seeded.unwrapFirst] != null &&
            gUnwrap.rows[seeded.unwrapSecond] != null,
          JSON.stringify({
            first: gUnwrap.rows[seeded.unwrapFirst],
            second: gUnwrap.rows[seeded.unwrapSecond],
          }),
        );
        r.ok(
          "unwrap: their text is intact",
          (await textOf(page, seeded.unwrapFirst)) === "first inside" &&
            (await textOf(page, seeded.unwrapSecond)) === "second inside",
          `${await textOf(page, seeded.unwrapFirst)} | ${await textOf(page, seeded.unwrapSecond)}`,
        );
        const endRow = gUnwrap.rows[seeded.end];
        r.ok(
          "unwrap: both landed at the card's own level, not one deeper and not re-nested",
          endRow != null &&
            gUnwrap.rows[seeded.unwrapFirst]?.contentLeft ===
              endRow.contentLeft &&
            gUnwrap.rows[seeded.unwrapSecond]?.contentLeft ===
              endRow.contentLeft,
          `first=${gUnwrap.rows[seeded.unwrapFirst]?.contentLeft} second=${gUnwrap.rows[seeded.unwrapSecond]?.contentLeft} pageLevel=${endRow?.contentLeft}`,
        );
        r.ok(
          "unwrap: they kept their relative order",
          gUnwrap.order.indexOf(seeded.unwrapFirst) <
            gUnwrap.order.indexOf(seeded.unwrapSecond),
          `order=${JSON.stringify(gUnwrap.order)}`,
        );
        // Indent is evidence; `parentId` is proof. Promotion means landing in the
        // container's own slot, which only the persisted forest can confirm.
        const rowsAfterUnwrap = await storedRows(page, pageId);
        const byId = new Map(rowsAfterUnwrap.map((row) => [row.id, row]));
        r.ok(
          "unwrap: the persisted rows re-parent both children into the card's slot",
          byId.get(seeded.unwrapFirst)?.parentId === pageId &&
            byId.get(seeded.unwrapSecond)?.parentId === pageId &&
            byId.get(seeded.unwrapCard) === undefined,
          JSON.stringify({
            first: byId.get(seeded.unwrapFirst)?.parentId,
            second: byId.get(seeded.unwrapSecond)?.parentId,
            card: byId.get(seeded.unwrapCard),
            pageId,
          }),
        );
      }

      // --- 7. `/human` WRAPS an existing block --------------------------------
      // `wrapOnConvert: true`. A void container cannot retype the block: there is
      // nowhere for its text to go. So the origin keeps its id, type, `data` and
      // children and becomes the card's FIRST child, while a brand-new row is
      // minted for the card. Keeping the id is the load-bearing half — the
      // block's content `Y.Doc`, its owner and its registered focus handle
      // are ALL keyed by block id, so an id churn would drop the caret,
      // orphan the doc and split the undo history.
      const gBeforeWrap = await geometry(page, seeded.end);
      const ownersBeforeWrap = boxOwners(gBeforeWrap);
      const orderBeforeWrap = gBeforeWrap.order;
      if (!(await caretToStart(page, seeded.wrapMe))) {
        r.fail(
          "wrap: could not place the caret at the start of the origin block",
        );
      } else {
        // Caret at offset 0: `atWordBoundary` gates the `/` trigger and index 0 is
        // a boundary, so the block's own text survives to the other side.
        const originEditable = page
          .locator(
            `[data-block-id="${seeded.wrapMe}"] [contenteditable="true"]`,
          )
          .first();
        const caretBefore = await caretState(originEditable);
        // `/human` is the card's own name now; `/context` and `/user` still
        // reach it as aliases, which is what keeps the rename free for a user
        // who never reads a changelog.
        await page.keyboard.type("/human", { delay: 40 });
        await page.waitForTimeout(800);
        await snap(page, out, "4-slash-menu");
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2200);
        await snap(page, out, "5-wrapped");

        const gWrap = await geometry(page, seeded.end);
        const mintedCards = boxOwners(gWrap).filter(
          (id) => !ownersBeforeWrap.includes(id),
        );
        const anchorId = mintedCards[0];
        console.log("wrap:", JSON.stringify({ mintedCards, anchorId }));

        r.ok(
          "wrap: the origin block KEEPS its data-block-id",
          gWrap.rows[seeded.wrapMe] != null,
          `origin=${seeded.wrapMe}`,
        );
        r.ok(
          "wrap: the origin still holds its own text",
          (await textOf(page, seeded.wrapMe)) === "wrap me",
          await textOf(page, seeded.wrapMe),
        );
        r.ok(
          "wrap: exactly one new card appeared, and it is a NEW row — not the origin retyped",
          mintedCards.length === 1 &&
            anchorId !== seeded.wrapMe &&
            !orderBeforeWrap.includes(anchorId ?? ""),
          `minted=${JSON.stringify(mintedCards)} origin=${seeded.wrapMe}`,
        );
        r.ok(
          "wrap: the origin is nested one indent INSIDE the new card",
          anchorId != null &&
            (gWrap.rows[seeded.wrapMe]?.contentLeft ?? -1) >
              (gWrap.rows[anchorId]?.contentLeft ?? Infinity),
          `anchor=${anchorId != null ? gWrap.rows[anchorId]?.contentLeft : "n/a"} origin=${gWrap.rows[seeded.wrapMe]?.contentLeft}`,
        );
        r.ok(
          "wrap: the origin's own CHILD came along, still one indent under it",
          (gWrap.rows[seeded.wrapKid]?.contentLeft ?? -1) >
            (gWrap.rows[seeded.wrapMe]?.contentLeft ?? Infinity),
          `origin=${gWrap.rows[seeded.wrapMe]?.contentLeft} kid=${gWrap.rows[seeded.wrapKid]?.contentLeft}`,
        );
        r.ok(
          "wrap: the caret never left the origin (its id, and so its editor, survived)",
          caretBefore.anchorOffset != null &&
            (await caretState(originEditable)).insideBlock === true &&
            (await caretState(originEditable)).anchorOffset ===
              caretBefore.anchorOffset,
          `before=${caretBefore.anchorOffset} after=${JSON.stringify(await caretState(originEditable))}`,
        );

        // The structural half, which no rect can show: the origin kept its TYPE
        // (a wrap is not a conversion) and its subtree, and the minted row is the
        // `context` that now parents it.
        const rowsAfterWrap = await storedRows(page, pageId);
        const wrapById = new Map(rowsAfterWrap.map((row) => [row.id, row]));
        const originRow = wrapById.get(seeded.wrapMe);
        r.ok(
          "wrap: the origin kept its TYPE — `/human` wrapped it, it did not convert it",
          originRow?.type === "text",
          `type=${String(originRow?.type)}`,
        );
        r.ok(
          "wrap: the persisted forest is card > origin > kid",
          anchorId != null &&
            wrapById.get(anchorId)?.type === "context" &&
            originRow?.parentId === anchorId &&
            wrapById.get(seeded.wrapKid)?.parentId === seeded.wrapMe,
          JSON.stringify({
            anchor: anchorId != null ? wrapById.get(anchorId) : undefined,
            origin: originRow,
            kid: wrapById.get(seeded.wrapKid),
          }),
        );

        // --- 9. converge in a SECOND context --------------------------------
        // Fresh socket, cold load: the wrap and the Enter-minted sibling are
        // persisted STRUCTURE, re-derived from rows — not view state that
        // evaporates on reload.
        await page.waitForTimeout(2000);
        const { page: pageB } = await h.session({ label: "B" });
        await pageB.goto(pageUrl, { waitUntil: "domcontentloaded" });
        await pageB
          .locator(`[data-block-id="${seeded.end}"]`)
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
        await pageB.waitForTimeout(2500);
        await snap(pageB, out, "6-context-b");

        const gB = await geometry(pageB, seeded.end);
        console.log("context B owners:", JSON.stringify(boxOwners(gB)));
        r.ok(
          "converge: the card's row is still zero-height with no editable of its own",
          gB.rows[seeded.card]?.height === 0 &&
            gB.rows[seeded.card]?.editable === false,
          JSON.stringify(gB.rows[seeded.card]),
        );
        const boxB = cardBox(gB, seeded.card);
        r.ok(
          "converge: a cold load re-derives the box around the heading-first card",
          boxB != null &&
            firstLineInside(gB, boxB) === seeded.cardHead &&
            boxB.bottom >= (gB.rows[seeded.cardTail]?.bottom ?? Infinity) - 1,
          JSON.stringify({
            boxB,
            first: boxB ? firstLineInside(gB, boxB) : undefined,
          }),
        );
        const newRowB = gB.rows[newId];
        const childRowB = gB.rows[seeded.enterChild];
        const enterBoxB = cardBox(gB, seeded.enterCard);
        r.ok(
          "converge: the Enter-minted line is still a sibling inside its card's box",
          newRowB != null &&
            childRowB != null &&
            newRowB.contentLeft === childRowB.contentLeft &&
            enterBoxB != null &&
            enterBoxB.bottom >= newRowB.bottom - 1,
          JSON.stringify({ new: newRowB, child: childRowB, box: enterBoxB }),
        );
        r.ok(
          "converge: the wrap persisted — the minted card still parents the origin, which still holds its child",
          anchorId != null &&
            boxOwners(gB).includes(anchorId) &&
            (gB.rows[seeded.wrapMe]?.contentLeft ?? -1) >
              (gB.rows[anchorId]?.contentLeft ?? Infinity) &&
            (gB.rows[seeded.wrapKid]?.contentLeft ?? -1) >
              (gB.rows[seeded.wrapMe]?.contentLeft ?? Infinity),
          JSON.stringify({
            owners: boxOwners(gB),
            anchor: anchorId != null ? gB.rows[anchorId] : undefined,
            origin: gB.rows[seeded.wrapMe],
            kid: gB.rows[seeded.wrapKid],
          }),
        );
        r.ok(
          "converge: the unwrapped children are still at page level, outside every box",
          gB.rows[seeded.unwrapFirst]?.contentLeft ===
            gB.rows[seeded.end]?.contentLeft &&
            gB.rows[seeded.unwrapSecond]?.contentLeft ===
              gB.rows[seeded.end]?.contentLeft,
          JSON.stringify({
            first: gB.rows[seeded.unwrapFirst],
            second: gB.rows[seeded.unwrapSecond],
            end: gB.rows[seeded.end],
          }),
        );
      }
    }
  }

  console.log("PAGE_URL:", pageUrl);
  await r.finish();
});
