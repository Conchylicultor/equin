import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { createElement } from "react";
import {
  HOST_MARKER_ATTR,
  type FixtureMutation,
} from "@plugins/primitives/plugins/css/plugins/layout-harness/plugins/geometry/core";
import type {
  MeasuredBox,
  MeasuredFixture,
} from "@plugins/primitives/plugins/css/plugins/layout-harness/core";
import { loadExhibits } from "@plugins/plugin-meta/plugins/exhibits/core";
import {
  measurableExhibits,
  type MeasurableExhibit,
} from "./measurable-exhibits";
import { RAIL_MARKER_ATTR } from "./region-children";
import type { HarnessWindow } from "./harness-window";
// The ONLY place the real Tailwind stylesheet is imported — the exhibits
// themselves never import it (so they stay Bun-safe). Bundling it here means the
// measured page paints with the exact tokens/utilities the live app uses.
import "@plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css";

// ── The browser side of the geometry harness ────────────────────────
//
// This module is bundled by `build-measurer-page.ts` (Vite + React + Tailwind)
// into a static page loaded by Playwright. It exposes two globals the measure
// driver calls per (fixture, width):
//
//   window.__renderFixture(id, width, falsify?) → mount the fixture at `width`,
//       optionally applying a falsification mutation to the painted DOM.
//   window.__measure() → read the `[data-geo]` boxes into a MeasuredFixture.
//
// The width axis is a styled wrapper, NOT a viewport resize: one loaded page
// re-renders per width via these globals (no reload per width). The `window`
// globals are typed in the ambient `harness-globals.d.ts`.

const container = document.getElementById("root")!;
let root: Root | null = null;
let byId: Map<string, MeasurableExhibit> = new Map();

function ensureRoot(): Root {
  if (!root) root = createRoot(container);
  return root;
}

function box(el: Element): MeasuredBox {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    right: r.right,
    top: r.top,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

function px(value: string): number {
  const n = parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}

/** Where a box's CONTENT starts. See `MeasuredFixture["slots"]`. */
function contentLeftOf(el: HTMLElement): number {
  return el.getBoundingClientRect().left + px(getComputedStyle(el).paddingLeft);
}

// ── Optical centre: where a box's INK looks centred ────────────────
//
// Every other measurement here comes out of `getBoundingClientRect`, and that is
// precisely why the repo could not see a row whose icon sits below its own
// words: the BOXES are centred on each other perfectly, and the letters are not
// in the middle of theirs. So this is the one measurement that asks what is
// DRAWN rather than what is reserved — the cap-to-baseline band of a text run,
// the `getBBox()` ink of a glyph.

// One canvas for the whole page's text metrics. `measureText` is a pure
// function of (font, string), so nothing about it is per-element.
const textMetricsCtx = (() => {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx)
    throw new Error(
      "optical centre: this browser gave no 2d canvas context, so text metrics cannot be read",
    );
  return ctx;
})();

// Assigning an unparsable string to `ctx.font` is a SILENT no-op — the previous
// font stays and `measureText` cheerfully answers about the wrong face. So each
// assignment is made from a known sentinel and checked to have moved off it. A
// box genuinely computing to `7px cursive` would read correctly anyway; the
// point is that a malformed shorthand can never pass unnoticed.
const FONT_SENTINEL = "7px cursive";

function metricsFor(el: Element, text: string): TextMetrics {
  const cs = getComputedStyle(el);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  textMetricsCtx.font = FONT_SENTINEL;
  textMetricsCtx.font = font;
  if (textMetricsCtx.font === FONT_SENTINEL) {
    throw new Error(
      `optical centre: canvas rejected the font shorthand "${font}" built from the computed style, so its text metrics would describe some other face`,
    );
  }
  return textMetricsCtx.measureText(text);
}

/**
 * The midpoint of a text run's ink top and its baseline — what the eye calls
 * the middle of a line of words.
 *
 * The line box is found with a `Range` over the first non-empty text node, not
 * from the marked element's own content box. A Range's first client rect IS the
 * line box the text sits in — its top and its height — however that line came to
 * be placed: inside a flex item centred by its row, below padding, as the first
 * of several lines. Deriving it from the marked box instead would silently
 * answer about the wrong y the moment the box was not the thing laying the text
 * out.
 *
 * Within that line box the baseline sits at half-leading + the font's ascent,
 * and the ink top is the ascent of THESE characters (`actualBoundingBoxAscent`)
 * — the cap height for a capitalised run, the x-height for a lowercase one.
 * The full text of the node is measured even when the box ellipsizes it, so the
 * number does not jump at the width where truncation starts.
 */
function textInkCenter(el: Element): number | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let textNode: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.trim() !== "") {
      textNode = node;
      break;
    }
  }
  const parent = textNode?.parentElement;
  if (!textNode || !parent) return null;
  const range = document.createRange();
  range.selectNodeContents(textNode);
  // One rect per line box; the first is the first line. A run that wrapped would
  // otherwise report a rect spanning every line, whose "half-leading" is
  // meaningless.
  const line = range.getClientRects()[0];
  if (!line || line.height === 0) return null;
  const m = metricsFor(parent, textNode.data);
  const fontBox = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const baseline =
    line.top + (line.height - fontBox) / 2 + m.fontBoundingBoxAscent;
  return baseline - m.actualBoundingBoxAscent / 2;
}

/** The inline-start/end-agnostic Y alignment fraction of a `preserveAspectRatio`. */
function alignFractionY(align: number): number {
  const P = SVGPreserveAspectRatio;
  if (
    align === P.SVG_PRESERVEASPECTRATIO_XMINYMIN ||
    align === P.SVG_PRESERVEASPECTRATIO_XMIDYMIN ||
    align === P.SVG_PRESERVEASPECTRATIO_XMAXYMIN
  )
    return 0;
  if (
    align === P.SVG_PRESERVEASPECTRATIO_XMINYMAX ||
    align === P.SVG_PRESERVEASPECTRATIO_XMIDYMAX ||
    align === P.SVG_PRESERVEASPECTRATIO_XMAXYMAX
  )
    return 1;
  // YMID, and the `unknown` value, which is what the initial `xMidYMid` is.
  return 0.5;
}

/**
 * The centre of an `<svg>`'s DRAWN ink, in viewport pixels.
 *
 * `getBBox()` is the union of what the shapes actually cover, in the viewBox's
 * own user units, so it is mapped onto the rendered rect the way the browser
 * maps everything else inside the viewBox: uniformly scaled and aligned per
 * `preserveAspectRatio`.
 *
 * The box centre would be the easy number and the wrong one. A Material glyph
 * is drawn inside a 24×24 viewBox with clear space around it, and an icon set
 * whose glyphs sit low in that box is exactly the kind of misalignment this
 * invariant exists to see.
 */
function svgInkCenter(svg: SVGSVGElement): number | null {
  // Not guarded: `__measure` only asks about boxes that generate one, and a
  // `getBBox` that threw anyway would be a harness fault, which belongs at the
  // top of the page as a fixture page error rather than quietly as "no ink".
  const bbox = svg.getBBox();
  if (bbox.height === 0) return null;
  const rect = svg.getBoundingClientRect();
  const cs = getComputedStyle(svg);
  const top = rect.top + px(cs.borderTopWidth) + px(cs.paddingTop);
  const width =
    rect.width -
    px(cs.borderLeftWidth) -
    px(cs.borderRightWidth) -
    px(cs.paddingLeft) -
    px(cs.paddingRight);
  const height =
    rect.height -
    px(cs.borderTopWidth) -
    px(cs.borderBottomWidth) -
    px(cs.paddingTop) -
    px(cs.paddingBottom);
  const vb = svg.viewBox.baseVal;
  // No viewBox: user units ARE css pixels, measured from the content box origin.
  if (vb.width === 0 || vb.height === 0) return top + bbox.y + bbox.height / 2;
  const par = svg.preserveAspectRatio.baseVal;
  const none =
    par.align === SVGPreserveAspectRatio.SVG_PRESERVEASPECTRATIO_NONE;
  const slice =
    par.meetOrSlice === SVGPreserveAspectRatio.SVG_MEETORSLICE_SLICE;
  const scaleY = none
    ? height / vb.height
    : slice
      ? Math.max(width / vb.width, height / vb.height)
      : Math.min(width / vb.width, height / vb.height);
  const offsetY = none
    ? top
    : top + (height - vb.height * scaleY) * alignFractionY(par.align);
  return offsetY + (bbox.y - vb.y + bbox.height / 2) * scaleY;
}

/**
 * A box's optical centre, or `null` when it bears no ink to have one.
 *
 * `null` is a measurement OUTCOME, not a default: the `opticalCenter` invariant
 * reports it as a failure, the same way `railAlignment` fails on an unpublished
 * rail. A spacer silently agreeing with every sibling is the shape of a gate
 * that has stopped checking anything.
 */
function opticalCenterOf(el: Element): number | null {
  if (el instanceof SVGSVGElement) return svgInkCenter(el);
  const text = textInkCenter(el);
  if (text !== null) return text;
  // A box wrapping ONE glyph and nothing else is that glyph, optically. Two
  // would be a question with two answers, so it has none.
  const svgs = el.querySelectorAll("svg");
  const only = svgs.length === 1 ? svgs[0] : null;
  return only instanceof SVGSVGElement ? svgInkCenter(only) : null;
}

// A rail this large is not a rail — it is the marker saying the property was
// never published, arriving as `var()`'s fallback so "unpublished" and "0px"
// stay distinguishable. Padding cannot be negative, so a negative sentinel would
// collapse back to 0 and lose exactly that distinction.
const RAIL_UNPUBLISHED_SENTINEL = 99_999;

/**
 * Resolve `--rail-start` / `--rail-end` to PIXELS as `host` sees them.
 *
 * By laying them out, never by parsing the computed text: the ramp declares
 * `--rail-start: var(--space-lg)`, whose computed value is the string `1rem`,
 * and control-panel's rails are `calc()` chains. `parseFloat` reads `1` and
 * `NaN` respectively — a rail that is wrong by a factor of 16, silently. Same
 * probe idiom as `ui-kit/e2e/scroll-fade-verify.ts`.
 */
function resolveRail(host: HTMLElement): {
  start: number | null;
  end: number | null;
} {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;top:-999999px;left:-999999px;visibility:hidden;width:0";
  host.appendChild(probe);
  const lengthOf = (name: string): number | null => {
    probe.style.height = `var(${name}, ${RAIL_UNPUBLISHED_SENTINEL}px)`;
    const h = probe.getBoundingClientRect().height;
    return Math.abs(h - RAIL_UNPUBLISHED_SENTINEL) < 0.5 ? null : h;
  };
  const start = lengthOf("--rail-start");
  const end = lengthOf("--rail-end");
  probe.remove();
  return { start, end };
}

/**
 * Find the box that PUBLISHED the rail the marker sees, walking up from the
 * marker to (and including) the container.
 *
 * Custom properties inherit, so the marker's computed `--rail-start` is shared
 * by every ancestor from the publisher down. The publisher is therefore the
 * OUTERMOST ancestor still reporting that same value — one step further up the
 * value changes (or disappears), because that is where the declaration is.
 *
 * Why bother, rather than measuring from the container: the rail is an offset
 * from the publisher's PADDING box, and the publisher is usually not the
 * harness's width wrapper. A bordered region (an `OverlayPanel`) sits one pixel
 * inside it, and a region rendered inside its own chrome sits further in still —
 * measuring from the wrapper would report every child as off-by-the-chrome.
 *
 * Boxless elements are never chosen as the host: the marker itself is
 * `display: contents`, and `railOverride` publishes ON the marker, so without
 * this the mutated run would resolve its origin to a 0×0 rect at the viewport
 * origin and "fail" for a reason unrelated to the rail.
 */
function railHostOf(
  marker: HTMLElement,
  containerEl: HTMLElement,
): HTMLElement {
  const published = getComputedStyle(marker).getPropertyValue("--rail-start");
  let host: HTMLElement | null = null;
  for (
    let el: HTMLElement | null = marker;
    el !== null && (el === containerEl || containerEl.contains(el));
    el = el.parentElement
  ) {
    if (getComputedStyle(el).getPropertyValue("--rail-start") !== published)
      break;
    if (el.getClientRects().length > 0) host = el;
    if (el === containerEl) break;
  }
  return host ?? containerEl;
}

/**
 * Apply a falsification mutation to the painted DOM, inside `scope` (the
 * harness container). The mutations reproduce the historical broken constructs
 * so the suite can prove the oracle bites on the wrong shape.
 */
function applyMutation(scope: HTMLElement, mutate: FixtureMutation): void {
  switch (mutate.kind) {
    case "templateOverride": {
      // Find the grid root (the Frame's `display:grid` element) and force a wrong
      // track function — reproduces a wrong grid-template-columns (e.g. the
      // weighted 3fr/1fr split that starves `meta`, inverting truncation onset).
      const grid = [...scope.querySelectorAll<HTMLElement>("*")].find(
        (el) => getComputedStyle(el).display === "grid",
      );
      if (!grid) {
        throw new Error(
          "templateOverride mutation: no `display:grid` element found in the fixture subtree",
        );
      }
      grid.style.gridTemplateColumns = mutate.value;
      break;
    }
    case "swapLeafDisplay": {
      if (mutate.value === "inline") {
        // The original single-line-leaf bug: a plain inline leaf silently no-ops
        // `overflow`/`text-overflow`, so the text lays out at full width and
        // overflows its block parent → `noClip` is violated.
        const leaf = scope.querySelector<HTMLElement>('[data-geo="content"]');
        if (!leaf) {
          throw new Error(
            'swapLeafDisplay:"inline" mutation: no `[data-geo="content"]` leaf found',
          );
        }
        leaf.style.display = "inline";
        leaf.style.maxWidth = "none";
        leaf.style.overflow = "visible";
        break;
      }
      if (mutate.value === "inline-block") {
        // The construct the block-level leaf replaced, and the one this whole
        // vertical invariant exists for.
        //
        // An inline-block whose overflow is not `visible` takes its BOTTOM
        // MARGIN EDGE as its baseline, so it sits entirely above the baseline of
        // the line it is on — and the block parent must still leave room for the
        // strut's descent underneath. The cell ends up several pixels taller than
        // the text in it, the text sits at the top of that cell, and the row's
        // `items-center` then centres every sibling against the inflated box. The
        // icon lands half the phantom space below the words.
        //
        // Nothing else is touched: no width, no overflow, no class. `truncate`
        // already supplies the `overflow: hidden` half, which is why restoring
        // one display keyword is the whole of the historical bug — and why every
        // horizontal invariant stays green under it.
        const leaf = scope.querySelector<HTMLElement>('[data-geo="content"]');
        if (!leaf) {
          throw new Error(
            'swapLeafDisplay:"inline-block" mutation: no `[data-geo="content"]` leaf found',
          );
        }
        leaf.style.display = "inline-block";
        break;
      }
      if (mutate.value === "absolute-pad") {
        // The old menu-indicator construct: float the checkmark indicator
        // `absolute` over the row and reserve space with right-padding — only a
        // hint the flexible label can ignore, so a long label slides UNDER the
        // indicator. We pull the indicator out of the grid flow (so its rigid
        // `trailing` track collapses to 0) and stretch the content leaf across
        // the full row width under it → `content.right > indicator.left` →
        // `noOverlap` is genuinely violated (measured boxes overlap).
        const indicator = scope.querySelector<HTMLElement>(
          '[data-geo="indicator"]',
        );
        const content = scope.querySelector<HTMLElement>(
          '[data-geo="content"]',
        );
        const grid = [...scope.querySelectorAll<HTMLElement>("*")].find(
          (el) => getComputedStyle(el).display === "grid",
        );
        if (!indicator || !content || !grid) {
          throw new Error(
            'swapLeafDisplay:"absolute-pad" mutation: need `[data-geo="indicator"]`, `[data-geo="content"]`, and a grid root',
          );
        }
        // Collapse the indicator's rigid grid cell to 0 and pull the indicator
        // out of flow (absolute over the row's right edge with a fixed offset),
        // so the content track spans the whole row — the old reservation-padding
        // shape where the absolute indicator only hints space the flexible label
        // ignores.
        grid.style.gridTemplateColumns = "1fr 0";
        grid.style.position = "relative";
        indicator.style.position = "absolute";
        indicator.style.right = "8px";
        indicator.style.top = "8px";
        // Force the content leaf to render its full intrinsic width (no
        // truncation) so its right edge genuinely overruns the absolute
        // indicator's left edge → measured boxes overlap.
        content.style.maxWidth = "none";
        content.style.overflow = "visible";
        content.style.whiteSpace = "nowrap";
        content.style.display = "inline-block";
        break;
      }
      throw new Error(`swapLeafDisplay: unsupported value "${mutate.value}"`);
    }
    case "railOverride": {
      // Re-publish the rail from the harness's own marker — BELOW the region,
      // ABOVE the children. Nothing moves: the region already laid its children
      // out, and the children never read the var themselves. All that changes is
      // the number the region claims to have used.
      //
      // That is the only mutation that isolates the assertion under test. Moving
      // the children instead would also trip `noClip` and `noOverlap`, so a
      // green `railAlignment` could hide behind its neighbours; this one is
      // invisible to every other invariant, so if the falsification bites, it
      // bit HERE.
      //
      // Setting it on the region itself would not take: the cascade is per
      // element, so the region's own declaration wins on the region's own box
      // whatever an ancestor says, `!important` included.
      const marker = scope.querySelector<HTMLElement>(`[${RAIL_MARKER_ATTR}]`);
      if (!marker) {
        throw new Error(
          `railOverride mutation: no [${RAIL_MARKER_ATTR}] in the fixture subtree — railOverride only applies to region fixtures, whose children the harness itself supplies`,
        );
      }
      marker.style.setProperty("--rail-start", mutate.value);
      marker.style.setProperty("--rail-end", mutate.value);
      break;
    }
    case "railOwedOverride": {
      // Same placement, and for the same cascade reason: the region declares
      // `--rail-owed-*: 0px` on its own box (the `rail-<step>` ramp does it in
      // the same breath as the padding), so only a declaration BELOW it reaches
      // the children.
      //
      // Only a `rail-follow` child reads the debt, so this moves exactly one
      // member and leaves the rest untouched — which is what makes a red result
      // here mean "the follower double-paid" and nothing else.
      const marker = scope.querySelector<HTMLElement>(`[${RAIL_MARKER_ATTR}]`);
      if (!marker) {
        throw new Error(
          `railOwedOverride mutation: no [${RAIL_MARKER_ATTR}] in the fixture subtree — railOwedOverride only applies to region fixtures, whose children the harness itself supplies`,
        );
      }
      marker.style.setProperty("--rail-owed-start", mutate.value);
      marker.style.setProperty("--rail-owed-end", mutate.value);
      break;
    }
    case "shrinkSlots": {
      // Hand the measured boxes back to the layout engine: let it take width
      // from them when their row runs out. That is the DEFAULT for a flex item
      // (`flex: 0 1 auto`), so this mutation does not invent a broken shape so
      // much as remove a deliberate one — which is what makes it the right
      // falsification for any primitive whose contract is "a box I measure is
      // the size of its own content, whatever else is in the row".
      //
      // `min-width: 0` rides along because a flex item's automatic minimum size
      // would otherwise stop the squeeze at min-content, and a slot whose
      // content is already unsqueezable (a button, a bare string) would report
      // a false green.
      const slots = [...scope.querySelectorAll<HTMLElement>("[data-geo]")];
      if (slots.length === 0) {
        throw new Error(
          "shrinkSlots mutation: no [data-geo] boxes in the fixture subtree",
        );
      }
      for (const slot of slots) {
        slot.style.flexShrink = "1";
        slot.style.minWidth = "0";
      }
      break;
    }
    case "swapSlotRole": {
      // Re-declare ONE measured slot as a different space-sharing role. The four
      // roles are the closed set the css primitives own; each is written here as
      // the longhand of the class those primitives emit, so a role gains a
      // spelling in exactly one more place than it already had.
      //
      // `flex` longhand rather than the `flex-1` shorthand because the BASIS is
      // the whole point: `fill`/`grow` are basis 0 (a claimant that shares the
      // row by grow factor), `yield`/`rigid` are basis auto (content-sized). It
      // is the basis, not the min-width, that makes a Fill squeeze its sibling
      // alone — writing `flex-grow: 1` and leaving the basis would silently
      // falsify nothing.
      const el = scope.querySelector<HTMLElement>(
        `[data-geo="${mutate.slot}"]`,
      );
      if (!el) {
        throw new Error(
          `swapSlotRole mutation: no [data-geo="${mutate.slot}"] box in the fixture subtree`,
        );
      }
      const ROLES = {
        // grow 0, shrink 0, basis auto — `shrink-0`
        rigid: { flex: "0 0 auto", minWidth: "auto" },
        // grow 0, shrink 1, basis auto, floor removed — `min-w-0`
        yield: { flex: "0 1 auto", minWidth: "0px" },
        // grow 1, shrink 1, basis 0, floor kept — `flex-1`
        grow: { flex: "1 1 0%", minWidth: "auto" },
        // both — `min-w-0 flex-1`
        fill: { flex: "1 1 0%", minWidth: "0px" },
      } as const;
      const role = ROLES[mutate.role];
      el.style.flex = role.flex;
      el.style.minWidth = role.minWidth;
      break;
    }
    case "shrinkWrapHost": {
      // Take the width away from the box the fixture named as the host and let
      // it size to its content instead. Inline, so it wins over whatever the
      // fixture's own `w-full` class said — the point is a host that CHANGED,
      // not one that was authored wrong.
      //
      // The primitive is already mounted when this lands, so a primitive that
      // only asks its question at mount has already asked it. That is not a
      // limitation of the mutation but the fault's real shape: a host is a
      // property of the tree above the primitive, and that tree keeps moving
      // after the primitive mounts.
      //
      // It also lands one beat too early to see the CURRENT width: the render has
      // committed, but a primitive that lays itself out from a `ResizeObserver`
      // has not been told about the new width yet, so `max-content` freezes the
      // layout the PREVIOUS width left behind. A fixture using this mutation
      // therefore sweeps wide → narrow, so what gets frozen is always smaller
      // than the container it is frozen inside — otherwise the stale layout
      // overflows on its own and the falsification proves nothing.
      const host = scope.querySelector<HTMLElement>(`[${HOST_MARKER_ATTR}]`);
      if (!host) {
        throw new Error(
          `shrinkWrapHost mutation: no [${HOST_MARKER_ATTR}] in the fixture subtree — the fixture must mark the box that hands its primitive a width, since only the fixture knows which box that is`,
        );
      }
      host.style.width = "max-content";
      break;
    }
    case "unpositionHost": {
      // Take the positioning context away from the box the fixture named as the
      // host. Its absolutely-positioned children then resolve their offsets
      // against the next positioned ancestor — the harness's own width wrapper,
      // which is `position: relative` and larger than any well-formed coordinate
      // host.
      //
      // Nothing else changes: the children keep every class and every inline
      // coordinate they were rendered with. That is what makes a red result here
      // mean "these numbers were measured against the wrong box" and nothing
      // else — and it is the real fault's shape too, since the property that
      // moved lives on an ancestor the children never mention.
      const host = scope.querySelector<HTMLElement>(`[${HOST_MARKER_ATTR}]`);
      if (!host) {
        throw new Error(
          `unpositionHost mutation: no [${HOST_MARKER_ATTR}] in the fixture subtree — the fixture must mark the box that establishes its primitive's positioning context, since only the fixture knows which box that is`,
        );
      }
      host.style.position = "static";
      break;
    }
  }
}

void loadExhibits().then((loaded) => {
  // The geometry-gated exhibits (and regions, filled with the kit) become one
  // measurable shape here, so everything below — render, measure, mutate —
  // deals in one shape. App exhibits are dropped without being loaded.
  const exhibits = measurableExhibits(loaded);
  byId = new Map(exhibits.map((f) => [f.id, f]));

  (window as HarnessWindow).__renderFixture = (id, width, falsify) => {
    const fixture = byId.get(id);
    if (!fixture)
      throw new Error(`__renderFixture: unknown exhibit id "${id}"`);
    // The harness wrapper itself carries `data-geo="container"` (the width box).
    // A fixture that authors its OWN inner `[data-geo="container"]` is honored by
    // __measure's innermost-container precedence.
    // `data-theme-scope` alongside `data-geo-root`, on the SAME element that
    // entry.html seeds the density ramp on. app.css declares its derived tokens
    // (`--hover-fill`, the whole `--cp-*` panel geometry) at
    // `:root, [data-theme-scope]`, and most of them read a density var. Custom
    // property substitution happens where the property is DECLARED, so anchored
    // on `:root` alone — where the harness seeds nothing — every one of them
    // computes to guaranteed-invalid and inherits down invalid: a
    // `grid-template-columns: var(--cp-gutter) …` then falls back to `none` and
    // the measured grid silently collapses to one column. Marking this element a
    // theme scope makes app.css re-declare them here, against the seeded ramp,
    // so the harness reads the tokens from their single source instead of the
    // page restating them.
    const tree = createElement(
      "div",
      {
        // A FRESH MOUNT per fixture, and per falsified/clean run of one.
        //
        // Every mutation in `applyMutation` writes INLINE STYLES imperatively —
        // React knows nothing about them. One root renders every fixture in
        // turn, so when two fixtures happen to share an element shape React
        // reconciles rather than remounts, hands the second one the first one's
        // DOM nodes, and the mutation's styles ride along into a run that never
        // asked for them. The second fixture then measures the FIRST one's
        // falsification and fails for a reason that is not in its own source.
        //
        // Keying on the fixture makes those nodes unreachable: React tears the
        // old tree down and builds a new one, so a mutation cannot outlive the
        // run that applied it. Widths within one run still reconcile, which is
        // what a measure-then-decide primitive (`AdaptiveBar`) needs to see a
        // width CHANGE rather than a first mount.
        key: `${id}::${falsify ? "mutated" : "clean"}`,
        "data-geo-root": "",
        "data-theme-scope": "",
      },
      createElement(
        "div",
        { "data-geo": "container", style: { width, position: "relative" } },
        fixture.render(),
      ),
    );
    // flushSync so the subtree is committed synchronously; __measure (called
    // after a rAF tick from the driver) then sees the final layout.
    flushSync(() => ensureRoot().render(tree));
    if (falsify) {
      const scope = container.querySelector<HTMLElement>(
        '[data-geo="container"]',
      );
      if (!scope)
        throw new Error("__renderFixture: container missing after render");
      applyMutation(scope, falsify);
    }
  };

  (window as HarnessWindow).__measure = () => {
    // Prefer the INNERMOST `[data-geo="container"]` so a fixture that authors its
    // own container (e.g. pin/menu-indicator-over-label's relative div) measures
    // against it rather than the harness width wrapper.
    const containers = [
      ...container.querySelectorAll<HTMLElement>('[data-geo="container"]'),
    ];
    if (containers.length === 0)
      throw new Error("__measure: no [data-geo='container']");
    const containerEl = containers.reduce((innermost, el) =>
      innermost.contains(el) ? el : innermost,
    );
    const slots: MeasuredFixture["slots"] = {};
    const order: string[] = [];
    for (const el of container.querySelectorAll<HTMLElement>("[data-geo]")) {
      const key = el.getAttribute("data-geo")!;
      if (key === "container") continue;
      if (el === containerEl) continue;
      // An element that generates NO BOXES is not a geometry participant, and
      // measuring it invents one. `display:none` makes `getBoundingClientRect()`
      // all zeros, so a hidden slot would report a 0×0 box at the viewport
      // origin — which "overlaps" every sibling by its full width and "clips"
      // past every container edge. Both are artefacts of asking a
      // non-participant where it is.
      //
      // Skipping it here (rather than in each oracle rule) makes it identical to
      // a slot the fixture did not render at all, which every rule already
      // tolerates — `noOverlap` and `noClip` both skip absent slots. Any fixture
      // with a conditionally-shown affordance needs this; the adaptive bar's `⋯`
      // trigger, hidden while nothing has overflowed, was the first.
      if (el.getClientRects().length === 0) continue;
      order.push(key);
      slots[key] = {
        box: box(el),
        truncates: el.scrollWidth > el.clientWidth,
        contentLeft: contentLeftOf(el),
        opticalCenter: opticalCenterOf(el),
      };
    }
    // The rail is read where the CHILDREN read it — from inside the region, off
    // the harness's own marker — because custom properties inherit downward and
    // the region publishes on its own box, a descendant of the container. A
    // fixture that authors its own children has no marker, so the container is
    // asked instead; those fixtures assert no `railAlignment`, and the fields
    // are then simply the ambient rail, whatever it is.
    const marker = container.querySelector<HTMLElement>(
      `[${RAIL_MARKER_ATTR}]`,
    );
    const railHost = marker ? railHostOf(marker, containerEl) : containerEl;
    const rail = resolveRail(marker ?? containerEl);
    const railRect = railHost.getBoundingClientRect();
    return {
      container: box(containerEl),
      slots,
      order,
      // The padding box, not the border box: a region's border sits outside the
      // rail it publishes.
      railOrigin:
        railRect.left + px(getComputedStyle(railHost).borderLeftWidth),
      railStart: rail.start,
      railEnd: rail.end,
    };
  };

  (window as HarnessWindow).__fixturesReady = true;
});
