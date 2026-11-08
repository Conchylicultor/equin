import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useMemo, type RefObject } from "react";
import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * A popover's anchor lost its box while the popover was positioned against it
 * — it left the document, or something hid it (`display: none` on it or an
 * ancestor). Floating UI measures such an element as an empty rect at the
 * viewport's origin, so the panel jumped to the screen's top-left corner;
 * {@link steadyAnchor} keeps it where it was instead, and files this.
 *
 * The panel staying put is the cure for the symptom, not for the cause: an
 * anchor vanishing under an open popover is the bug of whoever hid it, and
 * this names it. Carried as elements (not strings) so the consumer that files
 * it — a plugin that may know the app's lineage attributes, which this
 * primitive must not — reads what it needs off them.
 */
export interface PopoverAnchorLostFault {
  /** `detached`: no longer in the document. `no-box`: in it, but drawn as nothing. */
  cause: "detached" | "no-box";
  /** The element the popover is anchored to (its trigger, or the caller's `anchor`). */
  anchor: Element;
  /** The nearest element (the anchor itself included) whose computed `display`
   *  is `none` — who hid it. `null` when detached, or when nothing up the
   *  chain is `display: none` (a `display: contents` anchor, say). */
  hiddenBy: Element | null;
  /** The popover's positioner (portaled; carries the forwarded attributes). */
  positioner: Element | null;
}

/**
 * Where a lost anchor goes in production. `reports/popover-anchor-lost`
 * registers the mapping to a filed report; with nothing registered `emit` only
 * holds a bounded backlog.
 */
export const popoverAnchorLostSink = defineReportSink<PopoverAnchorLostFault>();

/** What Floating UI positions against: a rect, and the element whose scroll
 *  ancestors, resizes and moves it keeps tracking (`autoUpdate` unwraps it). */
export interface SteadyAnchor {
  getBoundingClientRect(): DOMRect;
  readonly contextElement: Element | undefined;
}

function boxCause(el: Element): PopoverAnchorLostFault["cause"] | null {
  if (!el.isConnected) return "detached";
  return el.getClientRects().length === 0 ? "no-box" : null;
}

function displayNoneAncestor(el: Element): Element | null {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (getComputedStyle(cur).display === "none") return cur;
  }
  return null;
}

/**
 * An anchor that measures `target`'s element while it has a box, and holds
 * the last rect it measured while it has none — so a popover never re-lays
 * itself out against a vanished element (an empty rect at 0,0: the panel in
 * the screen's top-left corner). Each time the element loses its box the loss
 * is emitted into {@link popoverAnchorLostSink} once; it re-arms when the box
 * comes back. A ref target is read at every measurement (falling back to
 * `fallback` while it is empty, as base-ui does), so a ref repointed at a new
 * node is measured as the new node. Refs, not getters, so a render can build
 * one without reading `.current`.
 */
export function steadyAnchor(
  target: Element | RefObject<Element | null>,
  fallback: Element | null,
  positionerRef: RefObject<Element | null>,
): SteadyAnchor {
  const resolve = () =>
    target instanceof Element ? target : (target.current ?? fallback);
  let lastGood: DOMRect | null = null;
  let lost = false;
  return {
    get contextElement() {
      return resolve() ?? undefined;
    },
    getBoundingClientRect() {
      const el = resolve();
      if (!el) return lastGood ?? new DOMRect();
      const cause = boxCause(el);
      if (cause === null) {
        lost = false;
        lastGood = el.getBoundingClientRect();
        return lastGood;
      }
      if (!lost) {
        lost = true;
        popoverAnchorLostSink.emit({
          cause,
          anchor: el,
          hiddenBy: cause === "no-box" ? displayNoneAncestor(el) : null,
          positioner: positionerRef.current,
        });
      }
      // Never measured with a box (opened against an already-hidden anchor):
      // there is no good place to keep, and the element's own empty rect is
      // what Floating UI would have used anyway.
      return lastGood ?? el.getBoundingClientRect();
    },
  };
}

type PositionerAnchor = PopoverPrimitive.Positioner.Props["anchor"];

/**
 * The anchor `PopoverContent` hands base-ui: whatever element it would have
 * positioned against — the caller's `anchor` (an element, a ref, or a function
 * returning one) or, with none, the popover's trigger — wrapped in a
 * {@link steadyAnchor}. A ref or function that comes back empty falls back to
 * the trigger, as base-ui itself does. A caller's virtual element (a caret, a
 * point) passes through: it has no box to lose.
 */
export function useSteadyAnchor(
  anchor: PositionerAnchor,
  trigger: Element | null,
  positionerRef: RefObject<Element | null>,
): PositionerAnchor {
  return useMemo(() => {
    // No anchor (`null` included, as base-ui reads it): the trigger.
    if (anchor == null)
      return trigger ? steadyAnchor(trigger, null, positionerRef) : anchor;
    if (anchor instanceof Element)
      return steadyAnchor(anchor, null, positionerRef);
    if (typeof anchor === "function") {
      // Base-ui calls it once per open; one steady anchor per call.
      return () => {
        const resolved = anchor();
        if (resolved !== null && !(resolved instanceof Element))
          return resolved;
        const el = resolved ?? trigger;
        return el && steadyAnchor(el, null, positionerRef);
      };
    }
    if ("current" in anchor)
      return steadyAnchor(anchor, trigger, positionerRef);
    return anchor;
  }, [anchor, trigger, positionerRef]);
}
