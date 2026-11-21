import { useLayoutEffect, useState } from "react";
import { isAdaptiveBarItem } from "@plugins/primitives/plugins/adaptive-bar/web";
import { afterLayout } from "@plugins/primitives/plugins/dom/plugins/after-layout/web";

/**
 * Whether a divider at rest has nothing to separate: no item drawn anywhere
 * before it, or none drawn between it and the next divider (or the end).
 *
 * A contribution that renders `null` (a section gated off, an action with
 * nothing to offer) still leaves its reorder wrappers in the DOM — empty
 * `display: contents` boxes — so the layout tree alone cannot tell; this reads
 * what the siblings actually draw. Judged per divider, so a run of rules with
 * an empty group between keeps exactly one (the last: the earlier ones have
 * nothing after them), and a rule at either end of what shows goes.
 *
 * Re-judged on every change of the area's children (a MutationObserver on the
 * divider's parent: an item mounting or unmounting its content, an adaptive
 * bar hiding an occupant that came to nothing), never polled.
 *
 * Judged after layout, not in the effect: a divider in an adaptive bar's `⋯`
 * bucket is an occupant the bar moves into its panel in its OWN layout effect,
 * which runs after this one — the area is where the divider sits once the bar
 * has placed it. `placement` names that placement (the form the bar gave it),
 * so a move re-judges against the new neighbours.
 *
 * Returns the verdict and the callback ref for the rule's element (`null`
 * while it is not mounted, e.g. in edit mode — never judged then).
 */
export function useOrphanRule(
  placement: string,
): [orphan: boolean, ref: (el: HTMLElement | null) => void] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [orphan, setOrphan] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    // Watches the area the divider sits in NOW: a move out of it (the bar
    // docking the divider's box into its panel) is a change of the old area's
    // children, and re-targets the watch on the new one.
    let watched: Element | null = null;
    const judge = () => {
      const unit = siblingUnit(el);
      const parent = unit.parentElement;
      if (parent !== watched) {
        observer.disconnect();
        watched = parent;
        if (parent) {
          observer.observe(parent, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["hidden"],
          });
        }
      }
      if (parent) setOrphan(isOrphan(unit));
    };
    const observer = new MutationObserver(judge);
    const cancel = afterLayout(judge);
    return () => {
      cancel();
      observer.disconnect();
    };
  }, [el, placement]);
  return [el !== null && orphan, setEl];
}

/**
 * The element that stands for the divider among the area's entries: itself,
 * or the wrapper that holds only it — a box-less (`display: contents`) one (a
 * container's member span), or an adaptive bar's occupant container (a
 * divider in a `⋯` bucket, moved into the panel inside its own box).
 */
function siblingUnit(el: HTMLElement): Element {
  let unit: Element = el;
  for (
    let p = unit.parentElement;
    p && p.childElementCount === 1 && isWrapper(p);
    p = p.parentElement
  )
    unit = p;
  return unit;
}

/** A box that stands for the one entry inside it. */
function isWrapper(el: Element): boolean {
  return isContents(el) || isAdaptiveBarItem(el);
}

function isOrphan(unit: Element): boolean {
  let after = false;
  for (
    let s = unit.nextElementSibling;
    s && !isRule(s);
    s = s.nextElementSibling
  )
    if (draws(s)) {
      after = true;
      break;
    }
  if (!after) return true;
  // Before: anything drawn at all — past earlier rules too, which hide
  // themselves when the group between is empty.
  for (let s = unit.previousElementSibling; s; s = s.previousElementSibling)
    if (!isRule(s) && draws(s)) return false;
  return true;
}

function isRule(el: Element): boolean {
  return (
    el.getAttribute("role") === "separator" ||
    (isWrapper(el) &&
      el.childElementCount === 1 &&
      isRule(el.firstElementChild!))
  );
}

/** Whether the element paints a box: itself, or through a `contents` wrapper. */
function draws(el: Element): boolean {
  const display = getComputedStyle(el).display;
  if (display === "none") return false;
  if (display !== "contents") return true;
  for (const child of el.children) if (draws(child)) return true;
  return false;
}

function isContents(el: Element): boolean {
  return getComputedStyle(el).display === "contents";
}
