import { useLayoutEffect, useState } from "react";

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
 * divider's parent: an item mounting or unmounting its content), never polled.
 *
 * Returns the verdict and the callback ref for the rule's element (`null`
 * while it is not mounted, e.g. in edit mode — never judged then).
 */
export function useOrphanRule(): [
  orphan: boolean,
  ref: (el: HTMLElement | null) => void,
] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [orphan, setOrphan] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const unit = siblingUnit(el);
    const parent = unit.parentElement;
    if (!parent) return;
    const judge = () => setOrphan(isOrphan(unit));
    judge();
    const observer = new MutationObserver(judge);
    observer.observe(parent, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [el]);
  return [el !== null && orphan, setEl];
}

/**
 * The element that stands for the divider among the area's entries: itself,
 * or the box-less (`display: contents`) wrapper that holds only it — a
 * container's member span.
 */
function siblingUnit(el: HTMLElement): Element {
  let unit: Element = el;
  for (
    let p = unit.parentElement;
    p && p.childElementCount === 1 && isContents(p);
    p = p.parentElement
  )
    unit = p;
  return unit;
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
    (isContents(el) &&
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
