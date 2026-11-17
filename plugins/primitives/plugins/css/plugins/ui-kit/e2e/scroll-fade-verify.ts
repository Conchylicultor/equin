// OverlayPanel's scroll-edge fade — the "there is more below" signal.
//
// The claim under test is narrow and easy to fake, so every assertion reads the
// SAME element three ways: the panel's own scroll metrics (is there really more
// content that way?), the painted `::before`/`::after` opacity (is the gradient
// actually on?), and the PIXELS at each edge (did it land where the user would
// see it, and does it dissolve rather than cut off?). A fade that is always on
// would satisfy the second alone; a data attribute nobody styled would satisfy
// the first alone; a strip painted at full opacity outside the visible box
// satisfied both, and shipped.
//
// Two assertions are about the mechanism rather than any one state, and run
// wherever they apply:
//
//  - **no scrollable extent** — the panel re-measured with `scroll-edge-fade` off must
//    report the same `scrollHeight`. This is what "the fade never lies" reduces
//    to; a strip contributing even 4px makes a menu that fits paint a fade over
//    nothing.
//  - **painted geometry** — how far from the padded edge the content underneath
//    first shows through, bounded on both sides (see `edgeGeometry`).
//
// Four states, all driven on a throwaway page this script creates itself:
//
//  1. "Turn into" block menu at rest — bottom fade ON, top fade OFF.
//  2. The same menu scrolled into the middle — BOTH on.
//  3. The same menu scrolled to the end — top ON, bottom OFF.
//  4. The `/` slash menu filtered down until the list fits — NEITHER on.
//
// Usage: bun plugins/primitives/plugins/css/plugins/ui-kit/e2e/scroll-fade-verify.ts \
//          [--url <deploy>] [--out /tmp/scroll-edge-fade] [--headed]
import type { Page } from "playwright";
import {
  arg,
  colorDistance,
  report,
  samplePixels,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { type Rgba } from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { openBlankPage } from "@plugins/page/plugins/editor/e2e";

const out = arg("out", "/tmp/scroll-edge-fade");
const r = report();

const HANDLE = 'button[aria-label="Reorder or open block actions"]';

interface Probe {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** The same panel re-measured with the `scroll-edge-fade` class off. */
  scrollHeightBare: number;
  /** True when the panel really does have content past that edge. */
  moreAbove: boolean;
  moreBelow: boolean;
  attrTop: boolean;
  attrBottom: boolean;
  /** Painted opacity of the two sticky gradient strips. */
  paintTop: string;
  paintBottom: string;
}

/**
 * Read the most recently opened overlay panel. `.at(-1)` rather than `[0]`: a
 * dialog or a stale closing panel elsewhere in the DOM would otherwise be the
 * one measured.
 */
async function probe(page: Page): Promise<Probe | null> {
  return page.evaluate(() => {
    const el = [
      ...document.querySelectorAll<HTMLElement>(".scroll-edge-fade"),
    ].at(-1);
    if (!el) return null;
    const paintTop = getComputedStyle(el, "::before").opacity;
    const paintBottom = getComputedStyle(el, "::after").opacity;
    // LAST, and only after the opacities are read: dropping the class deletes
    // both pseudo-elements, so re-adding it restarts their 120ms opacity
    // transition — read the paint first and this stays invisible to everything
    // else. Reading `scrollHeight` forces the layout in between, which is the
    // whole point; no frame is painted inside one evaluate, so nothing flickers.
    el.classList.remove("scroll-edge-fade");
    const scrollHeightBare = Math.round(el.scrollHeight);
    el.classList.add("scroll-edge-fade");
    return {
      scrollTop: Math.round(el.scrollTop),
      clientHeight: Math.round(el.clientHeight),
      scrollHeight: Math.round(el.scrollHeight),
      scrollHeightBare,
      moreAbove: el.scrollTop > 1,
      moreBelow: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      attrTop: el.hasAttribute("data-fade-top"),
      attrBottom: el.hasAttribute("data-fade-bottom"),
      paintTop,
      paintBottom,
    };
  });
}

/** Assert one state end to end: metrics ⇒ attributes ⇒ paint. */
function expect(label: string, p: Probe, top: boolean, bottom: boolean): void {
  // The invariant the whole utility rests on, stated directly rather than
  // inferred from a symptom: whatever the strips do, the panel must measure
  // exactly as it would with no fade at all. `useScrollFade` reads
  // `scrollHeight` and believes it, so a strip that adds even 4px of extent
  // makes a menu that FITS arm a fade over content that does not exist. Asserted
  // in every state, because the failure only shows on panels shorter than the
  // strip — the states that look least worth checking.
  r.eq(
    `${label}: the fade adds no scrollable extent`,
    p.scrollHeight,
    p.scrollHeightBare,
  );
  r.eq(`${label}: content above?`, p.moreAbove, top);
  r.eq(`${label}: content below?`, p.moreBelow, bottom);
  r.eq(`${label}: data-fade-top`, p.attrTop, top);
  r.eq(`${label}: data-fade-bottom`, p.attrBottom, bottom);
  r.eq(`${label}: ::before painted`, p.paintTop, top ? "1" : "0");
  r.eq(`${label}: ::after painted`, p.paintBottom, bottom ? "1" : "0");
}

/**
 * Where the strip actually LANDS, read off the screen.
 *
 * Everything above this point is DOM-level, and DOM-level checks cannot see a
 * gradient: a pseudo-element has no rect to query, and its computed opacity
 * reports what it was given, not where it was painted. A top strip that was
 * fully opaque AND positioned outside the visible box once passed every
 * assertion in this file; only a screenshot caught it. So this reads pixels.
 *
 * It reads them TWICE — once as shipped, once with `scroll-edge-fade` removed — and
 * reports per-distance COVERAGE: how much the strip attenuates whatever is
 * underneath, `1 - faded/bare`. The second sample is not a luxury. The obvious
 * measurement, "how far in does content first appear", conflates *masked* with
 * *nothing there*: a menu row is mostly leading, so ~9px bands of bare
 * background sit between glyph rows, and the number then swings by half a row
 * depending on where a row boundary happens to land. Against its own unmasked
 * control, the same pixels answer the actual question.
 *
 * Two failure modes, one profile:
 *
 *  - **uncovered at the edge** ⇒ either the strip isn't there, or it parks short
 *    of the padded edge and leaves the unfaded sliver the `box-shadow` bleed
 *    exists to cover.
 *  - **still covered late in the ramp** ⇒ a CUTOFF, not a fade: the row under it
 *    is simply hidden rather than visibly dissolving, which is the whole point of
 *    a gradient.
 *
 * Both edges come out of ONE pair of screenshots, because restoring the class
 * restarts the strips' 120ms fade-in — a second capture would sample a
 * half-opaque strip and understate its coverage.
 *
 * `--chrome-mask` is never parsed: the reference background is SAMPLED, from a
 * state where the padded edge is provably unmasked (an unscrolled panel's top
 * edge has no fade and nothing under it).
 */
interface EdgeGeometry {
  /** Distance of the first content row the strip covers by less than 90%. */
  uncoveredAt: number;
  /** Distance at which coverage crosses 50%, interpolated between content rows. */
  clearedAt: number;
  /** Strongest deviation from the panel background in the unmasked control. */
  contrast: number;
  /**
   * The rail's block padding on THIS edge (`--rail-block-start` at the top,
   * `--rail-block-end` at the bottom) and `--scroll-fade-h`, in px, read off the
   * live panel. Per edge, because the strips are: one shared number for both was
   * silently wrong the moment a panel's block padding stopped being symmetric.
   */
  pad: number;
  ramp: number;
  profile: string;
}

async function panelGeometry(
  page: Page,
  bg: Rgba,
): Promise<{ top: EdgeGeometry; bottom: EdgeGeometry }> {
  const panel = page.locator(".scroll-edge-fade").last();
  const box = await panel.boundingBox();
  if (!box) throw new Error("panelGeometry: panel has no box");
  const css = await panel.evaluate((el) => {
    // Resolve the custom properties to PIXELS by laying them out, never by
    // parsing their text: `--scroll-fade-h` is `2.5rem` and the rail vars are
    // themselves `var()`s onto a spacing token, so `parseFloat` on the computed
    // value reads 2.5 and NaN respectively — an 18px band that never reaches
    // past the solid plateau, and assertions that then measure nothing.
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:-9999px;left:-9999px;visibility:hidden;width:0";
    el.appendChild(probe);
    const lengthOf = (name: string) => {
      probe.style.height = `var(${name})`;
      // An undefined var makes the declaration invalid → height auto → 0, which
      // is the same fallback each strip uses for its own `--rail-block-*`.
      return probe.getBoundingClientRect().height;
    };
    // Read BOTH block edges of the rail. The strips read one each (`::before`
    // takes `--rail-block-start`, `::after` `--rail-block-end`), so measuring one
    // number and asserting it at both edges would pass a panel whose bottom strip
    // reaches across the wrong distance.
    const padTop = lengthOf("--rail-block-start");
    const padBottom = lengthOf("--rail-block-end");
    const ramp = lengthOf("--scroll-fade-h");
    probe.remove();
    const s = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    return {
      padTop,
      padBottom,
      ramp,
      borderTop: px(s.borderTopWidth),
      borderBottom: px(s.borderBottomWidth),
      borderLeft: px(s.borderLeftWidth),
      borderRight: px(s.borderRightWidth),
    };
  });
  // The padding box, not the border box: the border is its own colour and would
  // read as "content" at distance 0. Inset horizontally as well, past the corner
  // radius, so an antialiased corner is not mistaken for content either.
  const rect = {
    x: box.x + css.borderLeft + 12,
    y: box.y + css.borderTop,
    width: box.width - css.borderLeft - css.borderRight - 24,
    height: box.height - css.borderTop - css.borderBottom,
  };
  const faded = await samplePixels(page, rect);
  // The control: the same pixels with no fade painting over them. Removing the
  // class changes no layout (that is asserted separately), so the two grids are
  // registered pixel for pixel.
  //
  // Held as an element HANDLE, not the locator: `.scroll-edge-fade` is the selector
  // the locator resolves by, so the moment the class comes off it matches
  // nothing and putting it back would time out. Restored in a `finally` — a
  // throw between the two would otherwise leave the panel unmasked for every
  // later assertion, and they would fail somewhere else entirely.
  const handle = await panel.elementHandle();
  if (!handle) throw new Error("panelGeometry: panel vanished");
  let control;
  try {
    await handle.evaluate((el) => el.classList.remove("scroll-edge-fade"));
    control = await samplePixels(page, rect);
  } finally {
    await handle.evaluate((el) => el.classList.add("scroll-edge-fade"));
    await handle.dispose();
  }

  /** How far the strip's paint reaches in from one edge. */
  const readEdge = (edge: "top" | "bottom"): EdgeGeometry => {
    const pad = edge === "top" ? css.padTop : css.padBottom;
    const depth = Math.min(faded.height, Math.round(css.ramp + 2 * pad + 16));
    const rows = Array.from({ length: depth }, (_, i) => {
      const y = edge === "top" ? i : faded.height - 1 - i;
      let bareDev = 0;
      let fadedDev = 0;
      for (let x = 0; x < faded.width; x++) {
        bareDev = Math.max(bareDev, colorDistance(control.at(x, y), bg));
        fadedDev = Math.max(fadedDev, colorDistance(faded.at(x, y), bg));
      }
      return { bareDev, fadedDev };
    });
    const contrast = Math.max(...rows.map((v) => v.bareDev));
    // Only a row with something under it can say anything about coverage — the
    // leading between glyph rows is background either way.
    const coverage = rows.map((v) =>
      v.bareDev > contrast * 0.25
        ? Math.min(1, Math.max(0, 1 - v.fadedDev / v.bareDev))
        : null,
    );
    // Only content rows carry a verdict, so both numbers are indexed over THEM.
    // Asking "how deep does full coverage reach" instead would answer with the
    // last row that happened to have glyphs under it — 3px on a panel whose last
    // item ends well above the edge, which says nothing about masking.
    const seen = coverage
      .map((c, i) => ({ i, c }))
      .filter((v): v is { i: number; c: number } => v.c !== null);
    const uncoveredAt = seen.find((v) => v.c < 0.9)?.i ?? depth;
    // The 50% crossing, interpolated between the two content rows bracketing it:
    // glyph rows are ~9px apart, so taking the first row under 50% reports the
    // ramp as up to a row longer than it is, and the budget below would have to
    // absorb that slack instead of measuring the ramp.
    let clearedAt = depth;
    for (let k = 0; k < seen.length; k++) {
      const cur = seen[k]!;
      if (cur.c >= 0.5) continue;
      const prev = [...seen.slice(0, k)].reverse().find((v) => v.c >= 0.5);
      clearedAt = prev
        ? prev.i + ((prev.c - 0.5) / (prev.c - cur.c)) * (cur.i - prev.i)
        : cur.i;
      break;
    }
    return {
      uncoveredAt,
      clearedAt: Math.round(clearedAt),
      contrast,
      pad,
      ramp: css.ramp,
      // Every row near the edge, every fourth after: a sliver is a one-pixel
      // event, so a coarse profile shows a failure without showing its shape.
      profile: coverage
        .map((c, i) =>
          (i < 14 || i % 4 === 0) && c !== null
            ? `${i}:${Math.round(c * 100)}`
            : null,
        )
        .filter(Boolean)
        .join(" "),
    };
  };
  return { top: readEdge("top"), bottom: readEdge("bottom") };
}

/**
 * The panel's own background, measured rather than parsed out of
 * `--chrome-mask`.
 *
 * Read at the TOP padding of an UNSCROLLED panel: no top fade is armed there and
 * nothing has scrolled under it, so those pixels are the surface itself. Fails
 * loudly if the row isn't uniform — that would mean the assumption is wrong and
 * every coverage number taken against it would be quietly meaningless.
 */
async function panelBackground(page: Page): Promise<Rgba> {
  const panel = page.locator(".scroll-edge-fade").last();
  const box = await panel.boundingBox();
  if (!box) throw new Error("panelBackground: panel has no box");
  const border = await panel.evaluate(
    (el) => parseFloat(getComputedStyle(el).borderTopWidth) || 0,
  );
  const grid = await samplePixels(page, {
    x: box.x + 16,
    y: box.y + border + 1,
    width: Math.max(1, box.width - 32),
    height: 1,
  });
  const first = grid.at(0, 0);
  for (let x = 1; x < grid.width; x++) {
    const spread = colorDistance(grid.at(x, 0), first);
    if (spread > 6)
      throw new Error(
        `panelBackground: the unscrolled top padding is not uniform (${spread} at x=${x}) — ` +
          `it is not the surface colour, so nothing measured against it would mean anything`,
      );
  }
  return first;
}

/** Assert one edge's painted geometry. */
function expectGeometry(label: string, g: EdgeGeometry): void {
  r.note(
    `${label}: ${JSON.stringify({ uncoveredAt: g.uncoveredAt, clearedAt: g.clearedAt, contrast: g.contrast })}`,
  );
  r.note(`${label} coverage % by distance: ${g.profile}`);
  r.ok(
    `${label}: something is actually under the strip`,
    g.contrast > 24,
    `strongest deviation ${g.contrast} with the fade off — nothing is under this edge, so the rest measures nothing`,
  );
  r.ok(
    `${label}: the padded edge is masked`,
    g.uncoveredAt > g.pad,
    `content is under 90% covered ${g.uncoveredAt}px in, inside the panel's own ${g.pad}px padding — the unfaded sliver`,
  );
  r.ok(
    `${label}: the mask is a fade, not a wall`,
    g.clearedAt <= g.pad + g.ramp * 0.65,
    `content is still ≥50% covered at ${g.clearedAt}px of a ${g.ramp}px ramp (budget ${g.pad + g.ramp * 0.65}px)`,
  );
}

/**
 * The one precondition of the state under test — what must be TRUE of the
 * panel's own geometry before "settled" can mean anything.
 *
 * Without one, every wait here is trivially satisfiable by the state that came
 * BEFORE the interaction: `page.mouse.wheel` resolves before the browser has
 * begun animating the scroll, and `keyboard.type` resolves before React has
 * re-rendered the filtered list, so a check that only asks "has it stopped
 * changing?" answers yes about the previous state.
 */
interface FadeGate {
  /** The scroll must have actually moved off this offset. */
  movedFrom?: number;
  /** The panel must overflow — nothing to signal if it fits. */
  scrollable?: boolean;
  /** The panel must NOT overflow — the filtered-down case. */
  fits?: boolean;
}

/** Wheel over the open panel, then let the fade settle at its new offset. */
async function wheelPanel(page: Page, dy: number): Promise<void> {
  const panel = page.locator(".scroll-edge-fade").last();
  await panel.hover({ position: { x: 40, y: 40 } });
  const movedFrom = await panel.evaluate((el) => Math.round(el.scrollTop));
  await page.mouse.wheel(0, dy);
  await settleFade(page, { movedFrom });
}

/**
 * Wait until nothing the assertions read can still change — asking the BROWSER,
 * never sleeping for a duration.
 *
 * The fade lands in three hops, and a probe taken between any two of them reads
 * a half-updated frame: the scroll animation lands, THEN React commits the
 * measurement into `data-fade-*`, THEN the 120ms opacity transition runs. In a
 * headless browser painting at ~10fps those hops span half a second, so the
 * middle plateau (attribute already on, `::before` opacity still at the
 * transition's start value of `0`) is wide enough to swallow any fixed wait —
 * which is exactly how this script used to fail on "turn-into mid".
 *
 * So each hop is waited on by its own signal:
 *
 *  1. **the gate + held geometry** — the interaction has taken effect, and
 *     `scrollTop`/`clientHeight`/`scrollHeight` are unchanged across two
 *     consecutive frames (a wheel scroll is animated; a filtered list reflows).
 *  2. **attributes agree with metrics** — React has committed. Bounded, so a
 *     hook that measured wrong never satisfies it and the wait fails loudly
 *     rather than the assertion reading a stale attribute.
 *  3. **no fade transition is running** — `getAnimations` reports the paint has
 *     finished moving. A CSS transition is dropped once it finishes, so an empty
 *     set is "arrived", and a fade whose CSS never matched arms no transition at
 *     all — it settles instantly at the wrong opacity and the assertion fires.
 */
async function settleFade(page: Page, gate: FadeGate = {}): Promise<void> {
  // The held-geometry memo lives on `window` because `waitForFunction` evaluates
  // a fresh function per poll — so it must be cleared per wait, or the last
  // frame of the previous state counts as this one's first.
  await page.evaluate(() => {
    delete (window as unknown as { __fadeGeom?: string }).__fadeGeom;
  });
  await page.waitForFunction(
    (g: FadeGate) => {
      const el = [
        ...document.querySelectorAll<HTMLElement>(".scroll-edge-fade"),
      ].at(-1);
      if (!el) return false;
      const scrollTop = Math.round(el.scrollTop);
      const { clientHeight, scrollHeight } = el;
      if (g.movedFrom !== undefined && scrollTop === Math.round(g.movedFrom))
        return false;
      if (g.scrollable === true && scrollHeight <= clientHeight) return false;
      if (g.fits === true && scrollHeight > clientHeight + 1) return false;

      const w = window as unknown as { __fadeGeom?: string };
      const geom = `${scrollTop}|${clientHeight}|${scrollHeight}`;
      const held = w.__fadeGeom === geom;
      w.__fadeGeom = geom;
      if (!held) return false;

      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + clientHeight < scrollHeight - 1;
      if (el.hasAttribute("data-fade-top") !== top) return false;
      if (el.hasAttribute("data-fade-bottom") !== bottom) return false;

      // Force the pending style recalc BEFORE asking what is animating: a
      // `waitForFunction` poll runs in an animation-frame callback, ahead of the
      // frame's own style update, so a transition the attribute flip just armed
      // does not exist yet — and an unforced `getAnimations` would report
      // "nothing animating" one frame too early, at opacity 0.
      void getComputedStyle(el, "::before").opacity;
      void getComputedStyle(el, "::after").opacity;
      return el
        .getAnimations({ subtree: true })
        .every((a) => !(a.effect as KeyframeEffect | null)?.pseudoElement);
    },
    gate,
    { polling: "raf", timeout: 15_000 },
  );
}

await withBrowser(async (h) => {
  const { page, captured } = await h.session({
    viewport: { width: 1280, height: 700 },
  });

  const doc = await openBlankPage(page, { settleMs: 500 });
  r.note(`throwaway page: ${doc.pageUrl}`);

  // ---- 1 / 2 / 3 — the "Turn into" menu -----------------------------------
  await doc.block.hover();
  await page.locator(HANDLE).first().click();
  await page.waitForSelector(".scroll-edge-fade", { timeout: 10_000 });
  await settleFade(page, { scrollable: true });

  const rest = await probe(page);
  await snap(page, out, "turn-into-rest");
  if (!rest) return r.fail("turn-into: panel found");
  r.note(`turn-into rest: ${JSON.stringify(rest)}`);
  r.ok(
    "turn-into: the panel is the clamped scroller",
    rest.scrollHeight > rest.clientHeight,
    `${rest.scrollHeight} vs ${rest.clientHeight} — nothing to signal if it fits`,
  );
  expect("turn-into rest", rest, false, true);

  // The surface colour every coverage number below is measured against — taken
  // here, while the panel is unscrolled and its top edge is provably unmasked.
  const bg = await panelBackground(page);
  r.note(`panel background: ${JSON.stringify(bg)}`);
  expectGeometry(
    "turn-into rest bottom",
    (await panelGeometry(page, bg)).bottom,
  );

  await wheelPanel(page, 120);
  const mid = await probe(page);
  await snap(page, out, "turn-into-mid");
  if (!mid) return r.fail("turn-into mid: panel found");
  r.note(`turn-into mid: ${JSON.stringify(mid)}`);
  expect("turn-into mid", mid, true, true);
  // Mid-scroll is the only state where BOTH strips paint, so it is the only one
  // that can show the two edges are the same ramp mirrored.
  const midGeom = await panelGeometry(page, bg);
  expectGeometry("turn-into mid top", midGeom.top);
  expectGeometry("turn-into mid bottom", midGeom.bottom);

  await wheelPanel(page, 2000);
  const end = await probe(page);
  await snap(page, out, "turn-into-end");
  if (!end) return r.fail("turn-into end: panel found");
  r.note(`turn-into end: ${JSON.stringify(end)}`);
  expect("turn-into end", end, true, false);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ---- 4 — the `/` menu, filtered until it fits ----------------------------
  await doc.block.click();
  await page.keyboard.type("/");
  await page.waitForSelector(".scroll-edge-fade", { timeout: 10_000 });
  await settleFade(page, { scrollable: true });

  const slashOpen = await probe(page);
  await snap(page, out, "slash-open");
  if (!slashOpen) return r.fail("slash: panel found");
  r.note(`slash open: ${JSON.stringify(slashOpen)}`);

  // Typing narrows the list with NO scroll event — the case a scroll listener
  // alone cannot see, and the reason the panel also runs a ResizeObserver.
  await page.keyboard.type("quo", { delay: 40 });
  await settleFade(page, { fits: true });
  const slashFiltered = await probe(page);
  await snap(page, out, "slash-filtered");
  if (!slashFiltered) return r.fail("slash filtered: panel found");
  r.note(`slash filtered: ${JSON.stringify(slashFiltered)}`);
  r.ok(
    "slash filtered: the list now fits",
    slashFiltered.scrollHeight <= slashFiltered.clientHeight + 1,
    `${slashFiltered.scrollHeight} vs ${slashFiltered.clientHeight}`,
  );
  expect("slash filtered", slashFiltered, false, false);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ---- 5 — Select is exempt BY CONSTRUCTION, not by luck --------------------
  // Under `alignItemWithTrigger` base-ui makes the inner `[role=listbox]` the
  // scroller and writes `height:100%` / `max-height:100%` down the chain, so the
  // PANEL never overflows and its fade never arms — Select keeps its own scroll
  // arrows with no double affordance. The pseudo-elements are new children of
  // that panel, so this is also the percentage chain's regression test.
  // Escape closes the menu but leaves the query text ("/quo") in the block, so
  // the block must be emptied first — otherwise the next query reads
  // "quo/code", matches nothing, and Enter inserts no code block at all. (That
  // was the real reason this section used to time out on the language picker:
  // the trigger was never in the DOM.)
  await doc.block.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/code", { delay: 40 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");

  // The picker is a hover-revealed affordance: present in the DOM but
  // `opacity-0 pointer-events-none` until the code block is hovered. Wait for
  // ATTACHED (opacity-0 still counts as visible to Playwright, so "visible"
  // would say nothing), then hover the block to arm it — `click()`'s own
  // actionability retry does the rest.
  const codeBlock = page
    .locator('[data-block-id]:has(button[aria-label="Code language"])')
    .first();
  const langTrigger = codeBlock
    .locator('button[aria-label="Code language"]')
    .first();
  await langTrigger.waitFor({ state: "attached", timeout: 10_000 });
  await codeBlock.hover();
  await langTrigger.click();
  // Scoped to the popup, NOT a bare `[role="listbox"]`. The page block editor used
  // to declare that role itself (it is a `role="group"` now), and it comes first in
  // document order — so the bare selector resolved to the PAGE, made this wait
  // vacuous, and measured the document instead of the list. Stay scoped anyway: a
  // bare role selector on a page full of widgets is a coincidence away from the
  // same bug.
  const listbox = page
    .locator('[data-slot="select-content"] [role="listbox"]')
    .first();
  await listbox.waitFor({ state: "visible", timeout: 10_000 });
  await settleFade(page);

  const select = await probe(page);
  await snap(page, out, "select-open");
  const list = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-slot="select-content"] [role="listbox"]',
    );
    if (!el) return null;
    return {
      clientHeight: Math.round(el.clientHeight),
      scrollHeight: Math.round(el.scrollHeight),
      arrows: document.querySelectorAll("[data-slot^=select-scroll]").length,
    };
  });
  r.note(
    `select panel: ${JSON.stringify(select)} / list: ${JSON.stringify(list)}`,
  );
  if (!select || !list) return r.fail("select: panel + listbox found");
  r.ok(
    "select: the LIST is the scroller (many languages)",
    list.scrollHeight > list.clientHeight,
    `${list.scrollHeight} vs ${list.clientHeight}`,
  );
  expect("select panel", select, false, false);

  await page.keyboard.press("Escape");
  r.ok(
    "no page errors",
    captured.pageErrors.length === 0,
    captured.pageErrors.join(" | "),
  );
});

await r.finish();
