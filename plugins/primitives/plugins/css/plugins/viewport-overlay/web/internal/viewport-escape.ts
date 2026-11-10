import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * A box that says `fixed inset-0` to mean "fill the viewport" expects two things
 * of its ancestor chain: that it covers the whole WINDOW, and that it paints
 * over the chrome beside it. Both are properties of elements ABOVE it rather
 * than of the box itself, and each has its own way of quietly failing:
 *
 *  - **containing block** — a `transform` / `filter` / `contain` anywhere up to
 *    `<html>` makes that element the containing block for fixed descendants, so
 *    the box stops at that element's content area instead of the viewport.
 *    (This is exactly what a `transform-gpu` on a surface backdrop does, which
 *    is why such a surface drops it while a viewport-relative placement is
 *    active.)
 *  - **stacking context** — `z-overlay` (40) only beats a rail's `z-nav` (20)
 *    because the two numbers are compared in the SAME stacking context. An
 *    ancestor that opens a new one — `opacity` below 1, `isolation: isolate`, a
 *    blend mode, a positioned element with a numeric `z-index` — traps the box
 *    inside it, and it stops covering that chrome while its geometry still looks
 *    perfectly right.
 *
 * Neither is expressible in CSS, and neither is visible to lint: the chain
 * crosses plugin boundaries and only exists once rendered. So it is checked at
 * runtime, the moment the box starts mattering, and it fails loudly — because
 * both failures look *almost* correct, which is how they survive review.
 *
 * The stacking half is deliberately conservative: a new stacking context on an
 * ancestor the chrome ALSO sits inside would in fact be harmless, but the check
 * cannot know which chrome a given caller has to cover. A loud false positive is
 * a five-minute conversation; the silent version is a bug report that says
 * "fullscreen looks fine".
 *
 * Everything below the {@link ViewportEscapeOptions} boundary is pure CSS: it
 * names no app, no surface and no placement. The one piece of domain knowledge —
 * WHAT breaks and what to do instead — is a string the caller supplies.
 */

/** Which of the two invariants an ancestor broke. */
export type ViewportBlockerReason = "containing-block" | "stacking-context";

export interface ViewportBlocker {
  /** The ancestor (or the audited element itself) standing in the way. */
  element: Element;
  /** Which promise it breaks — geometry, or coverage. */
  reason: ViewportBlockerReason;
  /** The CSS property responsible, e.g. `transform` / `isolation` / `z-index`. */
  property: string;
  /** That property's computed value, quoted back so the fix is obvious. */
  value: string;
}

/**
 * Properties that make an element the containing block for its `fixed`
 * descendants as soon as they are set to anything but their initial value. Read
 * through `getComputedStyle`, so an unset property reads `"none"` (or `""` in an
 * engine that does not implement it — jsdom, mostly).
 */
const CONTAINING_BLOCK_WHEN_SET = [
  "transform",
  "translate",
  "rotate",
  "scale",
  "perspective",
  "filter",
  "backdrop-filter",
];

/** The same set spelled as `will-change` accepts them (kebab-case, comma list). */
const WILL_CHANGE_TRIGGERS = [
  "transform",
  "translate",
  "rotate",
  "scale",
  "perspective",
  "filter",
  "backdrop-filter",
];

/** `contain` values that include paint or layout containment. */
const CONTAIN_TRIGGERS = ["paint", "layout", "content", "strict"];

/** Reads as "this property is at its initial value", across engines. */
function isUnset(value: string): boolean {
  return value === "" || value === "none";
}

/** A human handle for an element: `div.relative.h-full`, `div#root`, `html`. */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  // First four classes only — a Tailwind element's full class list is a wall of
  // text, and the first few are enough to find it in the source.
  const names =
    el.classList.length > 0
      ? `.${[...el.classList].slice(0, 4).join(".")}`
      : "";
  return `${tag}${id}${names}`;
}

/**
 * The containing-block half, for one element. Returns the property that captures
 * fixed descendants, or null when this element lets them through.
 */
function capturesFixed(
  style: CSSStyleDeclaration,
): Omit<ViewportBlocker, "element" | "reason"> | null {
  for (const property of CONTAINING_BLOCK_WHEN_SET) {
    const value = style.getPropertyValue(property);
    if (!isUnset(value)) return { property, value };
  }
  const willChange = style.getPropertyValue("will-change");
  const promised = willChange.split(",").map((p) => p.trim());
  if (WILL_CHANGE_TRIGGERS.some((t) => promised.includes(t))) {
    return { property: "will-change", value: willChange };
  }
  const contain = style.getPropertyValue("contain");
  if (CONTAIN_TRIGGERS.some((t) => contain.split(/\s+/).includes(t))) {
    return { property: "contain", value: contain };
  }
  // A container-query context contains its subtree too, so it captures fixed
  // descendants exactly like `contain: layout` does.
  const containerType = style.getPropertyValue("container-type");
  if (containerType !== "" && containerType !== "normal") {
    return { property: "container-type", value: containerType };
  }
  return null;
}

/**
 * The stacking-context half, for one element — the causes that do NOT already
 * capture fixed descendants (those are reported as the containing-block break,
 * which is the more visible symptom of the same declaration).
 */
function opensStackingContext(
  style: CSSStyleDeclaration,
): Omit<ViewportBlocker, "element" | "reason"> | null {
  const opacity = style.getPropertyValue("opacity");
  if (opacity !== "" && Number(opacity) < 1) {
    return { property: "opacity", value: opacity };
  }
  const isolation = style.getPropertyValue("isolation");
  if (isolation !== "" && isolation !== "auto") {
    return { property: "isolation", value: isolation };
  }
  const blend = style.getPropertyValue("mix-blend-mode");
  if (blend !== "" && blend !== "normal") {
    return { property: "mix-blend-mode", value: blend };
  }
  const position = style.getPropertyValue("position");
  // `fixed` and `sticky` open one on their own; the others need a real z-index.
  if (position === "fixed" || position === "sticky") {
    return { property: "position", value: position };
  }
  const zIndex = style.getPropertyValue("z-index");
  if (
    position !== "" &&
    position !== "static" &&
    zIndex !== "" &&
    zIndex !== "auto"
  ) {
    return { property: "z-index", value: `${zIndex} (position: ${position})` };
  }
  return null;
}

/**
 * Walk `from` (inclusive) up to `<html>` and return the FIRST element that stops
 * a viewport-relative box from reaching the viewport or from painting over the
 * chrome beside it.
 *
 * `null` means the chain is clear — the one outcome where a `fixed inset-0` box
 * really does fill the window and outrank the chrome. It is the success value
 * here rather than an absorbed failure: "found nothing" is the answer the caller
 * asked for, and every other answer is a populated blocker naming the culprit.
 */
export function findViewportBlocker(from: Element): ViewportBlocker | null {
  const root = from.ownerDocument.documentElement;
  let el: Element | null = from;
  while (el) {
    const style = getComputedStyle(el);
    // `display: contents` generates no box at all, so it can be neither a
    // containing block nor a stacking context, whatever else it declares.
    if (style.getPropertyValue("display") !== "contents") {
      const captured = capturesFixed(style);
      if (captured)
        return { element: el, reason: "containing-block", ...captured };
      // The root element IS the root stacking context — that is where a
      // fullscreen box and every body-portaled popover already live, so it is
      // never a blocker.
      if (el !== root) {
        const stacked = opensStackingContext(style);
        if (stacked)
          return { element: el, reason: "stacking-context", ...stacked };
      }
    }
    if (el === root) break;
    el = el.parentElement;
  }
  return null;
}

/**
 * The ways a viewport-relative box is *broken*, as opposed to merely arranged
 * differently. One kind per symptom, because the two are diagnosed differently:
 * a clipped fullscreen and a fullscreen that lost to the rail look nothing
 * alike. Both are properties of CSS rather than of any one caller, which is why
 * they live here and only the wording travels in.
 */
export type ViewportEscapeFaultKind =
  /** An ancestor captured the box, so it is not full-viewport. */
  | "viewport-containing-block"
  /** An ancestor trapped the box's z-layer, so it covers less chrome. */
  | "viewport-stacking-context";

export interface ViewportEscapeFault {
  kind: ViewportEscapeFaultKind;
  /** The caller's own name for what breaks — see {@link ViewportEscapeOptions}. */
  subject: string;
  /** The whole finding as one sentence: what broke, where, and what to do. */
  message: string;
  /**
   * The offending element as a STRING (`div.relative.h-full`), never the node.
   * A report is a POST: it is serialized, stored and read back long after that
   * element is gone, so a node reference would be both unsendable and a
   * retained-DOM leak.
   */
  blocker: string;
}

/**
 * Where a viewport-escape fault goes in production. A domain plugin
 * (`reports/viewport-escape`) registers the mapping to a filed report; with
 * nothing registered `emit` only holds a bounded backlog, which is what keeps this primitive
 * usable in a test harness — and is exactly why the app composition MUST carry
 * a collector.
 */
export const viewportEscapeReportSink = defineReportSink<ViewportEscapeFault>();

export interface ViewportEscapeOptions {
  /**
   * What breaks, in the words of what the user will actually see — "a
   * fullscreen (solo) tab", `a <ViewportOverlay layer="draw">`. The ONLY domain
   * knowledge in play, and the caller supplies it.
   */
  subject: string;
  /** What to do instead, appended verbatim. */
  remedy?: string;
  /**
   * Where the walk starts relative to the element handed in.
   *  - `"self"` (default) — the element IS the ancestor to audit: a backdrop or
   *    container that HOSTS fixed children (what `apps-core/surface` passes).
   *  - `"parent"` — the element IS the fixed box. A `position: fixed` element is
   *    its own stacking context, so an inclusive walk would always self-report;
   *    the chain it actually resolves against starts one level up.
   */
  from?: "self" | "parent";
}

/** The two symptoms, in the words of what the user will actually see. */
const SYMPTOM: Record<
  ViewportBlockerReason,
  { kind: ViewportEscapeFaultKind; effect: (subject: string) => string }
> = {
  "containing-block": {
    kind: "viewport-containing-block",
    effect: (subject) =>
      `${subject} will be clipped to that element instead of covering the window`,
  },
  "stacking-context": {
    kind: "viewport-stacking-context",
    effect: (subject) =>
      `${subject} is trapped in that element's stacking layer, so it stops covering the chrome painted beside it however high its own z-index is`,
  },
};

/**
 * Report, then throw in dev.
 *
 * Neither symptom is something to live with, and neither announces itself: the
 * box is "fullscreen", just 40px short, or fullscreen with a rail still down the
 * side. In dev the throw is the fastest possible feedback; in prod we file the
 * alert and keep painting, because an imperfect fullscreen is still a usable app
 * and taking the surface down is not.
 */
function failLoudly(fault: ViewportEscapeFault): void {
  viewportEscapeReportSink.emit(fault);
  if (import.meta.env.DEV) {
    throw new Error(`viewport-overlay: ${fault.message}`);
  }
}

/**
 * Assert that a viewport-relative box can actually reach the viewport AND
 * out-paint the chrome beside it. Call it once the invariants start mattering,
 * with the document's style clean (it reads computed style up every ancestor) —
 * `useViewportEscape` is that call, wrapped, run after the next paint.
 *
 * Returns the blocker it found, so a caller that wants to do something else with
 * it (log it, render a dev badge) is not forced to re-walk the chain; `null` is
 * the clear chain.
 */
export function assertViewportEscape(
  el: Element,
  { subject, remedy, from = "self" }: ViewportEscapeOptions,
): ViewportBlocker | null {
  const start = from === "parent" ? el.parentElement : el;
  // A detached element (`from: "parent"` on a child of nothing) has no chain to
  // audit — there is nothing above it to break the promise yet.
  if (!start) return null;

  const blocker = findViewportBlocker(start);
  if (!blocker) return null;

  const symptom = SYMPTOM[blocker.reason];
  failLoudly({
    kind: symptom.kind,
    subject,
    blocker: describeElement(blocker.element),
    message:
      `${subject} is positioned against the viewport, but ` +
      `<${describeElement(blocker.element)}> establishes a ${blocker.reason.replace("-", " ")} ` +
      `(${blocker.property}: ${blocker.value}). So ${symptom.effect(subject)}.` +
      (remedy ? ` ${remedy}` : ""),
  });
  return blocker;
}
