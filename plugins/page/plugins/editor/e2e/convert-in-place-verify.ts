// Convert-in-place verification (research/2026-07-28-page-block-write-ownership.md, Stage 1).
//
// What this pins: a conversion that CONSUMES some of the block's own text — the
// slash menu's `/query`, a markdown prefix — strips it from the block's CONTENT
// DOC and writes only the type to the row. The bug it locks out: the strip used
// to be a nested, deferred Lexical update on an editor the type change unmounts,
// while the "real" stripped text was handed to `convertTo` as a row payload —
// but `page_blocks.data.text` is a PROJECTION of the doc, so a row write cannot
// strip anything. End state was a permanent disagreement:
//
//     DOM / content doc:  "/callout"                 ← still there
//     page_blocks row:    type=callout, text=[]      ← converted, text cleared
//
// Per case (fresh blank page each, so nothing carries over):
//   1. the block's row `type` is `wantType`;
//   2. the `/query` (or `> `) marker is gone from the DOM *and* from `data.text`;
//   3. `data.text` ≡ the DOM text — the divergence check that failed before;
//   4. the block id is unchanged and the caret is still collapsed inside it.
//
// Plus one targeted case for the other half of Stage 1: flipping a to-do
// checkbox mid-typing must not write the row's lagged `text` projection back,
// and one DOM-NODE-IDENTITY round trip (`/quote` and `/prompt`, there and back)
// that is the executable spec for `TextBlockLayout`'s totality rules — see
// research/2026-07-29-page-text-block-presentation-api.md.
//
// `/callout` is a WRAP, not a type swap (`BlockHandle.wrapOnConvert`): the origin
// keeps its id AND its `text` type and becomes the new anchor row's first child.
// The strip is exactly the same operation, which is why the case stays here; the
// container half of it is `callout/e2e/callout-wrap-verify.ts`.
//
// Rows are read authoritatively from `GET /api/pages/:pageId/blocks` (never the
// DOM's idea of the row), after polling for the ~1 s doc→`data.text` projection
// to settle — rows are allowed to TRAIL the doc, just never to disagree with it
// forever.
//
// Usage: bun plugins/page/plugins/editor/e2e/convert-in-place-verify.ts [--url <deploy>] [--out /tmp/convert]
import {
  pageFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { ElementHandle, Page } from "playwright";
import { blockText, openBlankPage } from "./support/blank-page";

const out = arg("out", "/tmp/convert");
const r = report("convert-in-place");

/** The projection debounce is ~1 s; poll well past it before calling a row stale. */
const PROJECTION_TIMEOUT_MS = 10_000;

interface Row {
  id: string;
  type: string;
  data: unknown;
}

/**
 * Does the row's `data` CARRY a `text` key at all?
 *
 * Deliberately not expressible through `rowPlain`, which answers `""` for a
 * missing `text` and for `text: []` alike — the two states this whole phase is
 * about. A void row must have no key (its strict schema rejects one); a
 * text-bearing row must have one (its schema requires it). Absence and emptiness
 * are different facts here, so they need different readers.
 */
function hasTextKey(row: Row): boolean {
  return (
    row.data !== null &&
    typeof row.data === "object" &&
    Object.prototype.hasOwnProperty.call(row.data, "text")
  );
}

/** Plain text of a row's `data.text` runs (the `RichText` array), NBSP-normalised. */
function rowPlain(row: Row): string {
  const text = (row.data as { text?: unknown } | null)?.text;
  if (!Array.isArray(text)) return "";
  return text
    .map((run) => String((run as { text?: unknown }).text ?? ""))
    .join("")
    .replace(/ /g, " ")
    .trim();
}

/**
 * Open a block's rail actions menu and pick one "Turn into" target.
 *
 * The hover is a real mouse move at a point inside the row rather than
 * `locator.hover()`: the rail is hover-REVEALED, and its controls stay
 * `pointer-events-none` until the row is genuinely hovered — the same reason
 * `container/e2e/container-rail-verify.ts` moves the mouse by hand, whose HANDLE
 * selector and popover scoping this borrows verbatim.
 *
 * The target rows are `Row` primitives with an `onMouseDown` commit and no
 * `onClick`, so they render as plain `div`s — no role to select by, which is why
 * this scopes an exact-text match to the popover's own content box instead of
 * reaching for `getByRole`. Returns false when the affordance never appeared:
 * "the menu has no such entry" is a real answer the caller reports.
 */
async function turnInto(
  page: Page,
  blockId: string,
  label: string,
): Promise<boolean> {
  const box = await page.evaluate((id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width * 0.6, y: b.top + Math.min(12, b.height / 2) };
  }, blockId);
  if (!box) return false;
  await page.mouse.move(box.x, box.y);
  await page.waitForTimeout(300);

  const handle = page
    .locator('button[aria-label="Reorder or open block actions"]')
    .first();
  if (!(await handle.isVisible())) return false;
  await handle.click();
  await page.waitForTimeout(400);

  const popover = page.locator('[data-slot="popover-content"]');
  const entry = popover.getByText(label, { exact: true }).first();
  if (!(await entry.isVisible())) return false;
  await entry.click();
  await page.waitForTimeout(400);
  return true;
}

/** Fetch the page's rows through the page's browser context (same session). */
async function fetchRows(page: Page, pageId: string): Promise<Row[]> {
  const res = await pageFetch(page, `/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`GET blocks failed: ${res.status}`);
  return (await res.json()) as Row[];
}

/**
 * The row for `blockId` once its `data.text` matches `wantPlain` — or the last
 * row seen when the window expires, so the caller reports the real divergence
 * rather than a timeout.
 */
async function rowWhenProjected(
  page: Page,
  pageId: string,
  blockId: string,
  wantPlain: string,
): Promise<Row | null> {
  const deadline = Date.now() + PROJECTION_TIMEOUT_MS;
  let last: Row | null = null;
  for (;;) {
    const rows = await fetchRows(page, pageId);
    last = rows.find((b) => b.id === blockId) ?? last;
    if (last && rowPlain(last) === wantPlain) return last;
    if (Date.now() > deadline) return last;
    await page.waitForTimeout(400);
  }
}

interface Case {
  label: string;
  /** Keystrokes composing the conversion, typed into the fresh block. */
  type: (page: Page) => Promise<void>;
  /** Expected `page_blocks.type` for the ORIGIN row afterwards. */
  wantType: string;
  /** Expected visible text afterwards (also the expected `data.text` plain). */
  wantText: string;
  /** Substring that must be gone from BOTH the DOM and `data.text`. */
  marker: string;
}

const cases: Case[] = [
  {
    // A WRAP: the origin stays a `text` block and gains a callout parent. What
    // this case pins is the strip, which is identical either way.
    label: "/callout",
    type: async (page) => {
      await page.keyboard.type("hello /callout", { delay: 25 });
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
    },
    wantType: "text",
    wantText: "hello",
    marker: "/callout",
  },
  {
    // Also a WRAP: `quote` is a void container too, so the origin stays a `text`
    // block and gains a quote parent.
    label: "/quote",
    type: async (page) => {
      await page.keyboard.type("hello /quote", { delay: 25 });
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
    },
    wantType: "text",
    wantText: "hello",
    marker: "/quote",
  },
  {
    // The other type that used to own a dispatch component. Its box, glyph and
    // action row are now `chrome` on the shared skeleton, so the strip and the
    // caret behave exactly as for any other text type.
    label: "/prompt",
    type: async (page) => {
      await page.keyboard.type("hello /prompt", { delay: 25 });
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
    },
    wantType: "prompt",
    wantText: "hello",
    marker: "/prompt",
  },
  {
    label: "/h1",
    type: async (page) => {
      await page.keyboard.type("hello /h1", { delay: 25 });
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
    },
    wantType: "heading-1",
    wantText: "hello",
    marker: "/h1",
  },
  {
    label: "markdown '> '",
    // No Enter: the shortcut fires on the transition INTO the prefixed state,
    // i.e. the moment the trailing space lands. `> ` is claimed by the TOGGLE
    // block, not quote (see the note in `quote/core/quote-block.ts`).
    type: async (page) => {
      await page.keyboard.type("> toggled", { delay: 25 });
    },
    wantType: "toggle",
    wantText: "toggled",
    marker: ">",
  },
  {
    // The other half of the prefix split: `| ` is a `typingPrefixes` entry, so
    // it fires here exactly like a `markdownPrefixes` one — the shortcut plugin
    // reads the UNION (`conversionPrefixesOf`). It is deliberately NOT markdown
    // syntax (`| ` opens a table row), which `markdown.test.ts` pins on the
    // clipboard side; this case pins the typing side. Quote is a container, so
    // the prefix WRAPS: the typed line stays `text` and becomes the quote's
    // first child, prefix stripped.
    label: "typing '| '",
    type: async (page) => {
      await page.keyboard.type("| wisdom", { delay: 25 });
    },
    wantType: "text",
    wantText: "wisdom",
    marker: "|",
  },
];

await withBrowser(async (h) => {
  const { page, captured } = await h.session({ label: "A" });

  for (const c of cases) {
    const doc = await openBlankPage(page, { settleMs: 3000 });
    const blockId = doc.blockId;
    r.note(`${c.label}: page ${doc.pageId} block ${blockId}`);

    await c.type(page);
    await page.waitForTimeout(1500);
    await snap(page, out, c.label.replace(/[^a-z0-9]+/gi, "-"));

    // The block is looked up BY ID: a conversion must keep the block's identity
    // (and therefore its content doc), so a new id here is itself the failure.
    const converted = page
      .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
      .first();
    const stillThere = (await converted.count()) > 0;
    r.ok(`${c.label}: block id unchanged`, stillThere, `looked for ${blockId}`);
    if (!stillThere) continue;

    const domText = await blockText(converted);
    const row = await rowWhenProjected(page, doc.pageId, blockId, c.wantText);
    if (!row) {
      r.fail(`${c.label}: row present`, `no row for ${blockId}`);
      continue;
    }
    const plain = rowPlain(row);
    r.note(`dom=${JSON.stringify(domText)} data.text=${JSON.stringify(plain)}`);

    // 1. the type changed.
    r.eq(`${c.label}: row type`, row.type, c.wantType);
    // 2. the marker is gone from BOTH owners.
    r.ok(
      `${c.label}: marker stripped from the DOM`,
      !domText.includes(c.marker),
      `dom=${JSON.stringify(domText)}`,
    );
    r.ok(
      `${c.label}: marker stripped from data.text`,
      !plain.includes(c.marker),
      `data.text=${JSON.stringify(plain)}`,
    );
    // 3. the two owners agree — the check that failed before Stage 1.
    r.eq(`${c.label}: data.text ≡ DOM text`, plain, domText);
    r.eq(`${c.label}: text preserved around the marker`, domText, c.wantText);

    // 4. the caret survived, collapsed, inside the same block.
    const caret = await page.evaluate((id: string) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0)
        return { has: false, collapsed: false, inside: false };
      const el = document.querySelector(
        `[data-block-id="${id}"] [contenteditable="true"]`,
      );
      return {
        has: true,
        collapsed: sel.isCollapsed,
        inside: !!el && !!sel.anchorNode && el.contains(sel.anchorNode),
      };
    }, blockId);
    const caretOk = caret.has && caret.collapsed && caret.inside;
    r.ok(
      `${c.label}: caret collapsed inside the block`,
      caretOk,
      JSON.stringify(caret),
    );
  }

  // --- DOM-node identity across a /quote wrap and a /prompt round trip --------
  //
  // The direct test for `TextBlockLayout`'s totality rules
  // (research/2026-07-29-page-text-block-presentation-api.md). Everything above
  // asserts the block's *row* identity; this asserts the identity of the DOM
  // ELEMENT: the very same `[contenteditable]` node — not merely an equal one —
  // must survive every conversion, in both directions.
  //
  // It is the only assertion that catches a skeleton element which vanishes: a
  // primitive collapsing to a Fragment on empty props, a region that changes the
  // children-array LENGTH instead of occupying one slot, or a per-type wrapper
  // sneaking back in. Any of those changes the element type at a position, React
  // unmounts the subtree, and the user's caret, focus and Yjs↔Lexical binding go
  // with it — the reported `/quote` bug, and the never-reported `/prompt` one.
  //
  // `/quote` is a WRAP now (quote is a void container), so its leg asserts the
  // same element survives being REPARENTED under a fresh anchor — a stronger
  // version of the original claim, and the reason the following `/prompt` legs
  // run on a block that is inside the quote: converting a container's child must
  // not touch the container.
  //
  // The prompt's chips are NOT asserted here: they only exist once a real agent
  // has been launched, which is `prompt/plugins/block/e2e/prompt-launch.ts`'s
  // job. The launch CONTROL is the observable proxy for the whole footer region.
  {
    const doc = await openBlankPage(page, { settleMs: 3000 });
    const blockId = doc.blockId;
    const sel = `[data-block-id="${blockId}"] [contenteditable="true"]`;
    r.note(`identity: page ${doc.pageId} block ${blockId}`);

    /** Hold the LIVE editable element, so identity can be compared later. */
    const grab = async (): Promise<ElementHandle<SVGElement | HTMLElement>> => {
      const h = await page.locator(sel).first().elementHandle();
      if (!h) throw new Error(`no contenteditable in block ${blockId}`);
      return h;
    };
    /** Is the element on screen right now the SAME node we grabbed before? */
    const stillSame = (held: ElementHandle<SVGElement | HTMLElement>) =>
      page.evaluate(
        ({ el, s }) => {
          const live = document.querySelector(s);
          return {
            same: live === el,
            connected: (el as Element).isConnected,
            present: !!live,
          };
        },
        { el: held, s: sel },
      );
    // `isVisible()` resolves false for a missing element — it does not throw —
    // so absence is a real answer here, not a swallowed failure.
    const launchVisible = () =>
      page
        .getByRole("button", { name: /^Launch / })
        .first()
        .isVisible();
    /** Commit a slash-menu conversion from the end of the block's text. */
    const convertVia = async (query: string) => {
      await page.locator(sel).first().click();
      await page.keyboard.press("End");
      await page.keyboard.type(` ${query}`, { delay: 25 });
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1200);
    };

    await page.keyboard.type("hello", { delay: 25 });
    await page.waitForTimeout(400);
    const held = await grab();

    for (const step of [
      // A WRAP: the row stays `text` and is reparented under a fresh quote anchor.
      {
        label: "→ quote (wrap)",
        query: "/quote",
        wantType: "text",
        wantLaunch: false,
      },
      {
        label: "→ prompt",
        query: "/prompt",
        wantType: "prompt",
        wantLaunch: true,
      },
      {
        label: "prompt → text",
        query: "/text",
        wantType: "text",
        wantLaunch: false,
      },
    ]) {
      await convertVia(step.query);
      await snap(
        page,
        out,
        `identity-${step.query.replace(/\W+/g, "")}-${step.wantType}`,
      );

      const node = await stillSame(held);
      r.ok(
        `identity ${step.label}: the SAME [contenteditable] element survived`,
        node.same && node.connected,
        JSON.stringify(node),
      );

      const rows = await fetchRows(page, doc.pageId);
      const row = rows.find((b) => b.id === blockId);
      r.eq(`identity ${step.label}: row type`, row?.type, step.wantType);
      r.eq(`identity ${step.label}: block id unchanged`, row?.id, blockId);

      // The footer region follows the TYPE, on the same untouched element tree.
      r.eq(
        `identity ${step.label}: launch control ${step.wantLaunch ? "present" : "absent"}`,
        await launchVisible(),
        step.wantLaunch,
      );
    }

    // Typing IMMEDIATELY after a conversion, with no re-focus, must land in the
    // same block — the caret never left it.
    await page.keyboard.type(" world", { delay: 25 });
    await page.waitForTimeout(1200);
    const afterTyping = await stillSame(held);
    r.ok(
      "identity: typing straight after the conversion kept the same element",
      afterTyping.same && afterTyping.connected,
      JSON.stringify(afterTyping),
    );
    // Each `/query` was typed after a space (the slash trigger needs a word
    // boundary) and only the QUERY is stripped, so the four conversions leave
    // four real spaces the user typed. Collapse runs of whitespace: what is under
    // test is that the keystrokes landed in this block, not the space count.
    const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
    const domAfter = await blockText(page.locator(sel).first());
    r.eq(
      "identity: the keystrokes landed in the same block",
      collapse(domAfter),
      "hello world",
    );
    const finalRow = await rowWhenProjected(
      page,
      doc.pageId,
      blockId,
      domAfter,
    );
    r.eq(
      "identity: data.text agrees after the round trip",
      finalRow ? collapse(rowPlain(finalRow)) : null,
      "hello world",
    );
    await snap(page, out, "identity-final");
  }

  // --- void SWAP targets: both directions of the row text rule ---------------
  // Not a case in the table above: that loop's first assertion is that the block
  // still has a `[contenteditable]`, which a void row by definition does not —
  // and `rowPlain` cannot tell a missing `text` from an empty one. The table
  // covers text→text swaps and wraps; this covers the swap into and back out of
  // a type that carries no text at all, which is where both halves of the rule
  // used to fail at the write boundary.
  {
    const doc = await openBlankPage(page, { settleMs: 3000 });
    const blockId = doc.blockId;
    r.note(`void swap: page ${doc.pageId} block ${blockId}`);
    // Console errors are captured for the whole run, so read a DELTA over this
    // phase and filter to the signature. A global "no console errors" assertion
    // would fail on unrelated reconnect/asset noise and stop meaning anything.
    const errorsBefore = captured.consoleErrors.length;

    await page.keyboard.type("hello /divider", { delay: 25 });
    await page.waitForTimeout(600);
    await page.keyboard.press("Enter");
    // Well past the ~1 s projection debounce: the rejected write this phase
    // exists for was posted BY that flush, so a shorter wait would miss it.
    await page.waitForTimeout(2500);
    await snap(page, out, "void-swap-divider");

    const afterSwap = (await fetchRows(page, doc.pageId)).find(
      (b) => b.id === blockId,
    );
    if (!afterSwap) {
      r.fail("void swap: row present", `no row for ${blockId}`);
    } else {
      r.eq("void swap: row type", afterSwap.type, "divider");
      r.ok(
        "void swap: the row carries NO `text` key",
        !hasTextKey(afterSwap),
        `data=${JSON.stringify(afterSwap.data)}`,
      );
    }
    const editables = await page
      .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
      .count();
    r.eq("void swap: no text surface on a void row", editables, 0);

    // …and back. `emptyRowData()` hands `convertTo` the target's defaults MINUS
    // `text`, and a divider has no projection to carry across — so this write
    // used to be `{}` against a schema that REQUIRES `text`, rejected whole,
    // taking the conversion with it.
    const turned = await turnInto(page, blockId, "Text");
    if (!turned) {
      r.fail(
        "void swap back: the rail menu offers Turn into \u2192 Text",
        `no reachable entry for ${blockId} \u2014 a divider is \`convertible\`, so this is a real regression`,
      );
    } else {
      await page.waitForTimeout(1500);
      await snap(page, out, "void-swap-back-to-text");

      const back = (await fetchRows(page, doc.pageId)).find(
        (b) => b.id === blockId,
      );
      r.eq("void swap back: row type", back?.type, "text");
      r.ok(
        "void swap back: the row carries a `text` key",
        back !== undefined && hasTextKey(back),
        `data=${JSON.stringify(back?.data)}`,
      );

      // The conversion must survive a reload — the optimistic overlay renders a
      // rejected write exactly like an accepted one, so the client's own idea of
      // the row proves nothing about what was persisted.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      const reloaded = (await fetchRows(page, doc.pageId)).find(
        (b) => b.id === blockId,
      );
      r.eq(
        "void swap back: still `text` after a reload",
        reloaded?.type,
        "text",
      );
    }

    const rejected = captured.consoleErrors
      .slice(errorsBefore)
      .filter((line) =>
        /blocks\/patch|Invalid data for block type|Unrecognized key/.test(line),
      );
    r.ok(
      "void swap: neither direction posted a row write the server rejected",
      rejected.length === 0,
      JSON.stringify(rejected),
    );
  }

  // --- the spread leak: a non-text control must not write text ----------------
  // `update` REPLACES the row's `data`, so the to-do checkbox used to restate
  // `{...data}` — including the row's ≤1 s-lagged `text` projection. Flip it
  // WHILE the projection is still pending and the row must end up with the text
  // the user typed, not the snapshot the checkbox carried.
  {
    const doc = await openBlankPage(page, { settleMs: 3000 });
    const blockId = doc.blockId;
    r.note(`to-do checkbox: page ${doc.pageId} block ${blockId}`);
    await page.keyboard.type("[] ", { delay: 25 });
    await page.waitForTimeout(600);
    await page.keyboard.type("buy milk", { delay: 25 });
    // Deliberately NO wait: the checkbox flip must race the pending projection.
    const checkbox = page
      .locator(`[data-block-id="${blockId}"] input[type="checkbox"]`)
      .first();
    await checkbox.click();
    await page.waitForTimeout(1500);
    await snap(page, out, "todo-checkbox");

    const block = page
      .locator(`[data-block-id="${blockId}"] [contenteditable="true"]`)
      .first();
    const domText = await blockText(block);
    const row = await rowWhenProjected(page, doc.pageId, blockId, "buy milk");
    if (!row) {
      r.fail("to-do checkbox: row present", `no row for ${blockId}`);
    } else {
      const plain = rowPlain(row);
      r.note(`dom=${JSON.stringify(domText)} data=${JSON.stringify(row.data)}`);
      r.eq("to-do checkbox: row type", row.type, "to-do");
      r.eq(
        "to-do checkbox: checked was written",
        (row.data as { checked?: unknown }).checked,
        true,
      );
      r.eq("to-do checkbox: DOM text intact", domText, "buy milk");
      r.eq("to-do checkbox: data.text not reverted", plain, "buy milk");
    }
  }
});

await r.finish();
