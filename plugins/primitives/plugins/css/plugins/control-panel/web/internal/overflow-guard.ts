import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { useEventCallback } from "@plugins/primitives/plugins/latest-ref/web";
import { useEffect, useRef, type RefObject } from "react";

import { CP_NEEDS_ATTR } from "./width-need";

/**
 * A control panel in a popover whose showing page is WIDER than the panel —
 * the measured backstop behind `width-need.ts`.
 *
 * The surface's width is its content's declared need. A need nobody declared
 * (a foreign grid in a `Section` without `needs`, a new kind of wide control)
 * leaves the panel at a narrower bucket than its content, and the content
 * spills past the panel's edge. That looks *almost* right — a row cut off at
 * the panel edge — which is how it reached a user's screenshot the first time
 * (the Fold rows page drawing the filter builder at menu width). So it is
 * measured where it happens and filed, rather than left to be noticed.
 */
export interface PanelOverflowFault {
  /** The panel's accessible label, or `"unlabelled panel"`. */
  label: string;
  /** The showing page's title (its back header), or `"root"`. */
  page: string;
  /** Every width need the showing page declares (`data-cp-needs`). */
  needs: readonly string[];
  /** The panel's own width, in px. */
  panelWidth: number;
  /** The width its content needs, in px. */
  contentWidth: number;
  /** The element whose content does not fit: the first one past the panel's
   *  edge, or the first grid cell its control spills out of. */
  offender: string;
  message: string;
}

/**
 * Where a panel-overflow fault goes in production. `reports/panel-overflow`
 * registers the mapping to a filed report; with nothing registered `emit` only
 * holds a bounded backlog.
 */
export const panelOverflowReportSink = defineReportSink<PanelOverflowFault>();

/** Sub-pixel layout rounding is not an overflow. */
const EPSILON = 0.5;

/**
 * Watch a control panel for content wider than the panel, and fail loudly
 * (report, and throw in dev) the first time it happens.
 *
 * Only a panel inside a `ControlPanelPopover` surface (`cp-surface`) is
 * watched — that is the host whose width is the content's need. A panel the
 * viewport has squeezed below its bucket (`max-width: var(--available-width)`
 * reached) is not a fault: no declaration could have made it fit.
 *
 * Push-based: `useResizeObserver` on the panel (its height follows its content)
 * plus a `MutationObserver` on its subtree (a pushed page, a level switch),
 * each coalesced to one measurement per frame. At most one fault per mount.
 */
export function usePanelOverflowGuard(
  ref: RefObject<HTMLElement | null>,
  label: string | undefined,
): void {
  const reported = useRef(false);
  const check = useEventCallback(() => {
    const root = ref.current;
    const surface = root?.closest<HTMLElement>(".cp-surface");
    if (!root || !surface || reported.current || !root.isConnected) return;
    const panelWidth = root.clientWidth;
    // `clientWidth` is 0 for a panel that is not laid out (a closing popup).
    if (panelWidth === 0) return;
    const overflow = measureOverflow(root, panelWidth);
    if (overflow === null) return;
    const cap = parseFloat(getComputedStyle(surface).maxWidth);
    if (
      Number.isFinite(cap) &&
      surface.getBoundingClientRect().width >= cap - EPSILON
    ) {
      return;
    }
    reported.current = true;
    failLoudly(describe(root, label, panelWidth, overflow));
  });

  // The panel's height follows its content, so a page growing a row resizes
  // it; the primitive debounces to one measurement per frame.
  useResizeObserver(ref, check);

  // A pushed page or a level switch can change the content without changing
  // the panel's size at all.
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const mutation = new MutationObserver(() => {
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          check();
        });
      }
    });
    mutation.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-cp-showing", CP_NEEDS_ATTR],
    });
    return () => {
      mutation.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [ref, check]);
}

interface Overflow {
  /** The width the content needs, in px. */
  contentWidth: number;
  /** The element whose content does not fit. */
  offender: HTMLElement | null;
}

/**
 * Content wider than the room it was given, in either of the two shapes it
 * takes:
 *
 * - the PANEL overflows — a rigid child reaches past the panel's edge
 *   (`scrollWidth` beyond its `clientWidth`);
 * - a CELL overflows — the row grids' tracks are `min-w-0`, so a builder row
 *   in a narrow panel does not push the panel at all: its tracks squeeze, and
 *   each control spills over its neighbour INSIDE the row (a date picker drawn
 *   over the remove button). Only a cell whose own overflow is visible counts:
 *   a cell that clips is truncating on purpose, and its ellipsis is the
 *   design, not a fault.
 */
function measureOverflow(
  root: HTMLElement,
  panelWidth: number,
): Overflow | null {
  const edge = root.getBoundingClientRect().right;
  const showing = root.querySelector<HTMLElement>("[data-cp-showing]") ?? root;
  if (root.scrollWidth - panelWidth > EPSILON) {
    const offender =
      [...showing.querySelectorAll<HTMLElement>("*")].find(
        (el) => el.getBoundingClientRect().right > edge + EPSILON,
      ) ?? null;
    return { contentWidth: root.scrollWidth, offender };
  }
  for (const cell of showing.querySelectorAll<HTMLElement>("[data-cp-cell]")) {
    const excess = cell.scrollWidth - cell.clientWidth;
    if (
      cell.clientWidth > 0 &&
      excess > EPSILON &&
      getComputedStyle(cell).overflowX === "visible"
    ) {
      return { contentWidth: panelWidth + excess, offender: cell };
    }
  }
  return null;
}

function describe(
  root: HTMLElement,
  label: string | undefined,
  panelWidth: number,
  { contentWidth, offender }: Overflow,
): PanelOverflowFault {
  const showing = root.querySelector<HTMLElement>("[data-cp-showing]") ?? root;
  const level = showing.getAttribute("data-cp-level");
  // The back header is the first row before the levels, and only exists on a
  // pushed page; its text is the page's title.
  const page =
    level === null || level === "0"
      ? "root"
      : (root.querySelector("[data-cp-cell='label']")?.textContent?.trim() ??
        `level ${level}`);
  const needs = [
    ...new Set(
      [...showing.querySelectorAll(`[${CP_NEEDS_ATTR}]`)].map(
        (el) => el.getAttribute(CP_NEEDS_ATTR) ?? "",
      ),
    ),
  ];
  const name = label ?? "unlabelled panel";
  const declared = needs.length > 0 ? needs.join(", ") : "none (menu)";
  return {
    label: name,
    page,
    needs,
    panelWidth,
    contentWidth,
    offender: offender ? selectorOf(offender) : "unknown",
    message:
      `control panel "${name}" (page: ${page}) is ${Math.round(panelWidth)}px ` +
      `wide but its content needs ${Math.round(contentWidth)}px. Declared ` +
      `width needs: ${declared}. The content that does not fit needs a ` +
      `width it does not declare — add \`needs\` to the ControlPanel.Section ` +
      `holding it (see control-panel width-need.ts).`,
  };
}

/** A short, human-readable path for an element: tag, data-cp-cell, classes. */
function selectorOf(el: HTMLElement): string {
  const cell = el.getAttribute("data-cp-cell");
  const classes = [...el.classList].slice(0, 3).join(".");
  return (
    el.tagName.toLowerCase() +
    (cell ? `[data-cp-cell="${cell}"]` : "") +
    (classes ? `.${classes}` : "")
  );
}

/**
 * Report, then throw in dev — the same policy `viewport-overlay` and
 * `adaptive-bar` take: an overflowing panel is still usable, so production
 * files the fault and keeps painting; dev gets the fastest feedback there is.
 */
function failLoudly(fault: PanelOverflowFault): void {
  panelOverflowReportSink.emit(fault);
  if (import.meta.env.DEV) {
    throw new Error(`control-panel: ${fault.message}`);
  }
}
