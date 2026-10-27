// Executable spec for the ANNOTATION FAMILY as a family — the four blocks that
// carry a page's human↔agent side-channel (`context` — the human card, whose
// stored type kept its old spelling — `todo`, `agent-note` (tagged
// `<agent-inline>` in markdown, stored type unchanged), `private-note`).
//
// Per-container behaviour (wrap, unwrap, Enter-in-a-child, nesting, the void
// write boundary) is already pinned by
// `plugins/human-notes/e2e/human-notes-container-verify.ts`, and every member is
// built by the SAME `defineAnnotationBlock` call, so this file deliberately does
// NOT re-run that suite four times. It checks only what is true of the family
// and of nothing else:
//
//  1. All four types are REGISTERED and VOID at the write boundary: `{}` is
//     accepted, a `text` key is a 400 (`handle.schema.strict()`).
//  2. Each paints ONE soft-tinted box — a fill and NO border at all — spanning its
//     own zero-height anchor row plus its whole subtree, and never the block that
//     follows it. The box is the card's own CONTENT box, so its left edge lands on
//     the same x as the first letter of the ordinary paragraph after the card,
//     rather than one `BLOCK_INSET` to the left of the prose as it used to.
//  3. The four boxes are visually DISTINCT — four different BACKGROUND colours.
//     With the dashed border and the gutter icon gone, the tint is the only mark
//     a card carries at rest, so hue is now the family's whole resting language.
//     A regression that collapsed two tints into one would leave every other
//     assertion here green.
//  4. Each card SAYS WHAT IT IS only when pointed at: its name sits in the box's
//     top-right corner, fully transparent at rest and revealed on hover. That
//     name is the seat the permanent margin glyph was replaced by, so "the card
//     is decorated" is now a claim about hover, not about paint.
//  5. All four are reachable from the `/` palette by the labels a user types.
//  6. `TODO ` typed at the start of a line WRAPS that line into a todo card, with
//     the prefix stripped and the line surviving as the card's first child — the
//     one member with a typed trigger, and the one thing here that is not shared.
//
// Convention: a box's owner is the FIRST row whose top sits on the box's top edge
// (a void anchor row is zero-height and precedes its first child in document
// order, so the anchor wins) — the same rule the human-notes spec uses, for the
// same reason: frames are grid SIBLINGS of the rows they cover, so DOM ancestry
// says nothing about ownership.
//
// Usage: bun plugins/page/plugins/annotations/e2e/annotations-verify.ts [--url <deploy>] [--out /tmp/annotations]
import {
  pageFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { blockText, openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/annotations");

const r = report();

/** Record one failure and stop. Used where nothing further is checkable. */
async function bail(name: string, detail: string): Promise<never> {
  r.fail(name, detail);
  return await r.finish();
}

/**
 * The family, in channel order — the same order the palette group declares.
 *
 * `label` is what a user types in the `/` palette; `name` is what the card calls
 * ITSELF in the corner of its own box, and the two deliberately differ for two
 * members (`TODO` vs `Todo`, `Private note` vs `Private`). Spelling both out is
 * what keeps the corner assertion honest — a locator that reused `label` would
 * silently pass by matching the palette entry instead of the card.
 *
 * `type` is the STORED value and is not always the card's spelling: the human
 * card still stores `context`. Every fixture below posts through the real write
 * boundary, so this field has to be what the server knows, never what the UI
 * shows.
 */
const MEMBERS = [
  {
    // The STORED type, which stayed `context` when the card was renamed to
    // Human — only the directory, symbol, label, corner chip and markdown tag
    // moved. Posting anything else here would 400 as an unknown block type,
    // which is also what keeps this entry honest about the rename's boundary.
    type: "context",
    label: "Human",
    name: "Human",
    child: "conventions live here",
  },
  {
    type: "todo",
    label: "TODO",
    name: "Todo",
    child: "wire the delivery filter",
  },
  {
    // The STORED type. Its markdown tag is `<agent-inline>`, and — like the
    // Human card's — that rename stopped at the tag.
    type: "agent-note",
    label: "Agent notes",
    name: "Agent notes",
    child: "found two call sites",
  },
  {
    type: "private-note",
    label: "Private note",
    name: "Private",
    child: "ask before shipping",
  },
] as const;

interface Box {
  top: number;
  bottom: number;
  left: number;
  /** The box's own background — the card's tint, and its whole mark at rest. */
  fill: string;
  /** Any border at all? An annotation card paints none: the tint IS the box. */
  bordered: boolean;
}

interface Row {
  top: number;
  bottom: number;
  height: number;
  contentLeft: number;
  /**
   * Where this row's own TEXT starts — its content edge plus one `BLOCK_INSET`.
   * Measured, never computed: the inset is a `--space-md` token that moves with
   * the density preset, so the only honest source is the rendered glyph line.
   * `null` for a row with no editable of its own (a void anchor row).
   */
  textLeft: number | null;
}

interface Geometry {
  boxes: Box[];
  rows: Record<string, Row | undefined>;
  /** Every block id in document order. */
  order: string[];
}

/**
 * Read the surface's geometry off the DOM in one pass — every row and every
 * painted backdrop, with no notion of which block owns which box. Ownership is
 * resolved below, in readable code, rather than by asking the browser a question
 * whose answer this script would have had to guess first.
 */
async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const rows: Record<string, Row> = {};
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
        height: rect.height,
        contentLeft:
          rect.left + parseFloat(getComputedStyle(el).paddingLeft || "0"),
        textLeft: editable ? editable.getBoundingClientRect().left : null,
      };
    }

    // Rows sit one wrapper deep in the block grid; frames are siblings of those
    // wrappers holding no rows of their own — which is how they are told apart.
    const anyRow = document.querySelector<HTMLElement>("[data-block-id]");
    const grid = anyRow?.parentElement?.parentElement;
    const boxes: Box[] = [];
    for (const child of grid ? [...grid.children] : []) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.querySelector("[data-block-id]") !== null) continue;
      // The wrapper only positions; the contribution inside it paints. Take the
      // first node in the subtree that actually paints — a background OR a
      // border. An annotation's box is a fill and nothing else, but the search
      // still admits a border so that a card which grew one back is FOUND and
      // fails the no-border assertion below, rather than going unmeasured.
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
        const bordered = ["top", "right", "bottom", "left"].some(
          (side) =>
            style.getPropertyValue(`border-${side}-style`) !== "none" &&
            parseFloat(style.getPropertyValue(`border-${side}-width`) || "0") >
              0,
        );
        if (!filled && !bordered) continue;
        const rect = node.getBoundingClientRect();
        boxes.push({
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          fill: bg,
          bordered,
        });
        break;
      }
    }
    return { boxes, rows, order };
  });
}

/**
 * The box a given block OWNS, i.e. the one starting on that block's row.
 *
 * The top edge alone is the discriminator here, and that is enough because this
 * fixture nests nothing: every card sits at page level with an ordinary
 * paragraph between it and the next, so no two boxes share a y. (The human-notes
 * spec, which DOES nest a card inside a callout, has to match the left edge too
 * — a nested card's box starts one `BLOCK_INDENT` further right.)
 */
function boxOf(g: Geometry, blockId: string): Box | undefined {
  const row = g.rows[blockId];
  if (!row) return undefined;
  return g.boxes.find((b) => Math.abs(b.top - row.top) <= 1);
}

/**
 * How visible a card's corner NAME is right now, as an effective opacity — the
 * product of every opacity between the chip and the card's own row.
 *
 * Playwright's `isVisible()` cannot answer this. The name is hidden with
 * `opacity-0`, not with `display: none`: it still lays out, still has a box, and
 * still passes an is-visible check. The reveal IS an opacity transition, so
 * opacity is the only thing worth reading — and reading it as a product means a
 * name faded out by an ancestor still counts as hidden.
 *
 * Scoped to the card's own anchor row, which is where the surface mounts the
 * corner seat. That scoping is load-bearing: `Human` and `Agent notes` are
 * also `/` palette entries, and a page-wide text query would happily find those
 * instead.
 */
async function cornerNameOpacity(
  page: Page,
  cardId: string,
  name: string,
): Promise<number | null> {
  return page.evaluate(
    ({ cardId, name }) => {
      const row = document.querySelector<HTMLElement>(
        `[data-block-id="${cardId}"]`,
      );
      if (!row) return null;
      const chip = [...row.querySelectorAll<HTMLElement>("*")].find(
        (el) => el.children.length === 0 && el.textContent?.trim() === name,
      );
      if (!chip) return null;
      let opacity = 1;
      for (
        let el: HTMLElement | null = chip;
        el !== null;
        el = el.parentElement
      ) {
        opacity *= parseFloat(getComputedStyle(el).opacity || "1");
        if (el === row) break;
      }
      return opacity;
    },
    { cardId, name },
  );
}

interface StoredRow {
  id: string;
  parentId: string | null;
  type: string;
}

/** The persisted forest — rects prove what is painted, only this proves structure. */
async function storedRows(page: Page, pageId: string): Promise<StoredRow[]> {
  const res = await pageFetch(page, `/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`GET blocks ${res.status}: ${await res.text()}`);
  return (await res.json()) as StoredRow[];
}

/** The write boundary's verdict on one `POST /api/blocks` body, verbatim. */
async function probePost(
  page: Page,
  pageId: string,
  type: string,
  data: unknown,
): Promise<{ status: number; body: string }> {
  const res = await pageFetch(page, "/api/blocks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parentId: pageId, type, data }),
  });
  return { status: res.status, body: await res.text() };
}

async function deleteBlock(page: Page, blockId: string): Promise<void> {
  const response = await pageFetch(page, `/api/blocks/${blockId}`, {
    method: "DELETE",
  });
  const res = { status: response.status, body: await response.text() };
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DELETE /api/blocks/${blockId} ${res.status}: ${res.body}`);
  }
}

interface Seeded {
  /** Per member type: its card id, its two children, and the block after it. */
  cards: Record<
    string,
    { card: string; head: string; tail: string; after: string }
  >;
  /** The trailing empty paragraph the `TODO ` trigger is typed into. */
  typing: string;
}

/**
 * Seed one card per member through `POST /api/blocks` and let a cold load
 * re-derive everything from persisted rows — no keystroke has run yet, so nothing
 * measured afterwards can be an artifact of the composing flow.
 *
 * Every payload is `{}`: an annotation is VOID, its content IS its children.
 */
async function seed(
  page: Page,
  pageId: string,
  members: [type: string, child: string][],
): Promise<Seeded> {
  const parent = pageId;
  const types = members;
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
  const text = (parentId: string, type: string, body: string) =>
    post({ parentId, type, data: { text: [{ text: body }] } });

      const cards: Record<
        string,
        { card: string; head: string; tail: string; after: string }
      > = {};
      for (const [type, childText] of types) {
        const card = await post({ parentId: parent, type, data: {} });
        // A HEADING first child on purpose: "the first visible line can be a
        // heading" is the property the void-container model exists to buy.
        const head = await text(card.id, "heading-2", type);
        const tail = await text(card.id, "bulleted-list", childText);
        const after = await text(parent, "text", `after ${type}`);
        cards[type] = {
          card: card.id,
          head: head.id,
          tail: tail.id,
          after: after.id,
        };
      }
      const typing = await text(parent, "text", "");
  return { cards, typing: typing.id };
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "annotations" });
  const { pageUrl, pageId } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);

  // --- 1. every member is registered AND void at the write boundary -----------
  // The pincer matters: an UNREGISTERED type also 400s (`resolveBlockHandle` →
  // "Unknown block type"), so the rejection alone would pass on a page where the
  // type does not exist at all. The accepted `{}` is what carries that proof.
  for (const { type } of MEMBERS) {
    const withText = await probePost(page, pageId, type, {
      text: [{ text: "no" }],
    });
    r.ok(
      `void schema: a \`${type}\` payload carrying \`text\` is REJECTED as an unrecognized key`,
      withText.status === 400 &&
        new RegExp(`Invalid data for block type "${type}"`).test(
          withText.body,
        ) &&
        /Unrecognized key/.test(withText.body),
      `status=${withText.status} body=${withText.body}`,
    );

    const withEmpty = await probePost(page, pageId, type, {});
    const accepted = withEmpty.status >= 200 && withEmpty.status < 300;
    r.ok(
      `void schema: \`${type}\` accepts \`{}\` — the type is registered and truly void`,
      accepted,
      `status=${withEmpty.status} body=${withEmpty.body}`,
    );
    if (accepted) {
      // Delete the probe row: it is a real childless card, and left on the page it
      // would add a box to every count below plus a prune target to the first
      // structural keystroke.
      const probeId = (JSON.parse(withEmpty.body) as { id?: string }).id;
      if (probeId === undefined)
        r.fail(`probe for ${type} returned a row`, withEmpty.body);
      else await deleteBlock(page, probeId);
    }
  }

  // --- seed ------------------------------------------------------------------
  const seeded = await seed(
    page,
    pageId,
    MEMBERS.map((m): [string, string] => [m.type, m.child]),
  ).catch((err: unknown): Promise<never> =>
    bail(
      "seed: the fixture posts through the write boundary",
      `${err instanceof Error ? err.message : String(err)} — nothing below is checkable`,
    ),
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator(`[data-block-id="${seeded.typing}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await snap(page, out, "1-family");

  const g = await geometry(page);

  // --- 2. one tinted box per card, spanning its subtree and nothing after -----
  const seenFills = new Map<string, string>();
  for (const { type } of MEMBERS) {
    const ids = seeded.cards[type];
    if (!ids) {
      r.fail(`${type}: seeded`, "missing from the seed result");
      continue;
    }
    const box = boxOf(g, ids.card);
    const anchorRow = g.rows[ids.card];
    const headRow = g.rows[ids.head];
    const tailRow = g.rows[ids.tail];
    const afterRow = g.rows[ids.after];
    if (!box || !anchorRow || !headRow || !tailRow || !afterRow) {
      r.fail(
        `${type}: paints a tinted box over its own row + subtree`,
        JSON.stringify({ box, anchorRow, headRow, tailRow, afterRow }),
      );
      continue;
    }
    r.ok(
      `${type}: the anchor row is ZERO HEIGHT — the card renders no line of its own`,
      anchorRow.height <= 1,
      `height=${anchorRow.height}`,
    );
    // The family signature is the TINT, not an edge. The dashed border is gone —
    // dashes, a margin icon and a hue were three marks doing one job, and a page
    // of three cards read as a stack of widgets rather than as a document with
    // asides. A card that grew any border back is the regression.
    r.ok(
      `${type}: its box paints a fill and NO border — the tint is the whole mark`,
      !box.bordered && box.fill !== "",
      JSON.stringify({ fill: box.fill, bordered: box.bordered }),
    );
    r.ok(
      `${type}: its box covers BOTH children`,
      box.top <= headRow.top + 1 && box.bottom >= tailRow.bottom - 1,
      JSON.stringify({ box, headRow, tailRow }),
    );
    r.ok(
      `${type}: its box stops before the following block`,
      box.bottom <= afterRow.top + 1,
      JSON.stringify({ boxBottom: box.bottom, afterTop: afterRow.top }),
    );
    r.ok(
      `${type}: its children are NESTED (one indent deeper than the block after it)`,
      headRow.contentLeft > afterRow.contentLeft,
      JSON.stringify({
        head: headRow.contentLeft,
        after: afterRow.contentLeft,
      }),
    );
    // THE alignment fact, and the reason the box moved at all: a card paints its
    // own CONTENT box, so its left edge shares an x with the first letter of the
    // ordinary paragraph right after it — same depth, same edge. It used to
    // start one `BLOCK_INSET` further left, at the decoration origin `C`, which
    // made the card the one decorated box on the page that did not line up with
    // the prose. Measured against the paragraph's real glyph line rather than
    // against a hardcoded 12px: `BLOCK_INSET` is a `--space-md` token and moves
    // with the density preset.
    r.ok(
      `${type}: its box's left edge lines up with the TEXT of the paragraph after it`,
      afterRow.textLeft !== null && Math.abs(box.left - afterRow.textLeft) <= 1,
      JSON.stringify({
        boxLeft: box.left,
        afterTextLeft: afterRow.textLeft,
        afterContentLeft: afterRow.contentLeft,
      }),
    );
    seenFills.set(type, box.fill);
  }

  // --- 3. the four hues are distinct ------------------------------------------
  // With no border and no icon left, the tint is the ONLY thing separating one
  // card from another at rest, so two members resolving to the same fill is a
  // collapse of the family's whole visual language — and every other assertion
  // in this file would stay green through it.
  const distinct = new Set(seenFills.values());
  r.ok(
    "family: the four members paint four DIFFERENT background colours",
    seenFills.size === MEMBERS.length && distinct.size === MEMBERS.length,
    JSON.stringify(Object.fromEntries(seenFills)),
  );

  // --- 4. the corner name: nothing at rest, the card's own name on hover ------
  // The decoration the margin glyph was replaced by. It is hidden with
  // `opacity-0` rather than unmounted, so this reads opacity: an
  // `isVisible()` check would pass in BOTH states and assert nothing.
  //
  // Hovering a CHILD row, not the box: the frame is a `pointer-events-none`
  // grid sibling of the rows it spans and can never be `:hover`ed itself, so
  // the reveal is driven by rows reporting which frames cover them
  // (`useSetFrameHover` → `useFrameHovered`). Pointing at a line inside the card
  // is also what a reader actually does.
  for (const { type, name } of MEMBERS) {
    const ids = seeded.cards[type];
    if (!ids) continue;
    const atRest = await cornerNameOpacity(page, ids.card, name);
    r.ok(
      `${type}: its name "${name}" is present but INVISIBLE at rest`,
      atRest !== null && atRest < 0.05,
      `opacity=${String(atRest)}`,
    );
    await page.locator(`[data-block-id="${ids.head}"]`).first().hover();
    await page.waitForTimeout(500);
    const hovered = await cornerNameOpacity(page, ids.card, name);
    r.ok(
      `${type}: pointing INSIDE the card reveals that name`,
      hovered !== null && hovered > 0.9,
      `opacity=${String(hovered)}`,
    );
  }
  // Taken with the last card still pointed at, so the shot shows a name where
  // the earlier ones show none.
  await snap(page, out, "2-corner-names");

  // --- 5. all four are in the `/` palette -------------------------------------
  // Clicking into the trailing paragraph below also clears the reveal: that row
  // reports no frames on pointer-enter, which is how a card stops naming itself.
  const editable = page
    .locator(`[data-block-id="${seeded.typing}"] [contenteditable="true"]`)
    .first();
  await editable.click();
  await page.keyboard.type("/");
  await page.waitForTimeout(600);
  await snap(page, out, "3-palette");
  for (const { label } of MEMBERS) {
    // Counted OUTSIDE the block rows, deliberately. Two of the cards now carry
    // their own name in the corner of their box — `Human`, `Agent notes` —
    // with the same words the palette uses, so `getByText` alone would find a
    // card and report the palette as present even if the entry had been
    // unregistered. The menu is portaled to the body, so "not inside any
    // `[data-block-id]`" is exactly "in the menu".
    const count = await page.evaluate(
      (text: string) =>
        [...document.querySelectorAll<HTMLElement>("*")].filter(
          (el) =>
            el.children.length === 0 &&
            el.textContent?.trim() === text &&
            el.closest("[data-block-id]") === null,
        ).length,
      label,
    );
    r.ok(`palette: \`/\` offers "${label}"`, count > 0, `matches=${count}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // Escape keeps the block and clears the query text; clear it explicitly so the
  // typed trigger below starts from a genuinely empty line.
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);

  // --- 6. typing `TODO ` wraps the line ---------------------------------------
  // The one member with a typed trigger. `MarkdownShortcutPlugin` strips the
  // prefix and calls `convertTo`, which for a `wrapOnConvert` type WRAPS — so the
  // line survives as the new card's first child, with its id (and caret) intact.
  await page.keyboard.type("TODO ");
  await page.waitForTimeout(800);
  await page.keyboard.type("write the delivery filter");
  await page.waitForTimeout(2000);
  await snap(page, out, "4-todo-trigger");

  const g2 = await geometry(page);
  const typedRow = g2.rows[seeded.typing];
  const stored = await storedRows(page, pageId);
  const typedStored = stored.find((b) => b.id === seeded.typing);
  const wrapper = stored.find((b) => b.id === typedStored?.parentId);

  r.ok(
    "TODO trigger: the typed line kept its id and became a CHILD of a new `todo` card",
    typedStored?.type === "text" && wrapper?.type === "todo",
    JSON.stringify({ typedStored, wrapper }),
  );
  r.ok(
    "TODO trigger: the prefix was stripped, the rest of the line survived",
    (await blockText(
      page
        .locator(`[data-block-id="${seeded.typing}"] [contenteditable="true"]`)
        .first(),
    )) === "write the delivery filter",
    await blockText(
      page
        .locator(`[data-block-id="${seeded.typing}"] [contenteditable="true"]`)
        .first(),
    ),
  );
  r.ok(
    "TODO trigger: the new card paints its tinted box over the line",
    wrapper !== undefined &&
      typedRow !== undefined &&
      (() => {
        const box = boxOf(g2, wrapper.id);
        return box !== undefined && box.bottom >= typedRow.bottom - 1;
      })(),
    JSON.stringify({ wrapper: wrapper?.id, typedRow }),
  );

  await r.finish();
});
