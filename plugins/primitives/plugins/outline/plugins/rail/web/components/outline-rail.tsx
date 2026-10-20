import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";

import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Column } from "@plugins/primitives/plugins/css/plugins/column/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import {
  FloatingAction,
  FloatingActionFadeIn,
} from "@plugins/primitives/plugins/overlay/plugins/floating-action/web";
import { useActiveInView } from "@plugins/primitives/plugins/outline/plugins/scroll-spy/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import type { OutlineEntry } from "../../core";
import { DASH_STEP_PX } from "../internal/depth";
import { DashStack } from "./dash-stack";
import { OutlineRow } from "./outline-row";

/**
 * Vertical space the dash stack leaves to the pane's top and bottom edges, so a
 * full-length rail reads as a floating indicator rather than a border. The rail
 * hangs from the top corner, so this is its own inset plus the gap it keeps
 * above the pane's bottom edge.
 */
const RAIL_RESERVE_PX = 48;

export interface OutlineRailProps {
  /** The outline, in document order. */
  entries: OutlineEntry[];
  /**
   * id → the entry's element. `null` when it is not mounted.
   *
   * **Must not reach outside your own surface.** The rail derives its
   * IntersectionObserver root from the scroll parent of the first element this
   * returns, so a query that can match another instance's DOM (two panes on one
   * document, ids unique per document but not per mount) makes the
   * current-position highlight track the wrong scroller — silently, not just on
   * click. Scope it to a container your host already holds.
   */
  resolve: (id: string) => Element | null;
  /**
   * An entry was picked whose element is not mounted (`resolve` gave null) —
   * content the host has not loaded yet (the older part of a long
   * transcript). The host brings it in and reveals it; without this, such a
   * pick does nothing.
   */
  onUnmounted?: (id: string) => void;
  /**
   * How a pick scrolls to its element; `smooth` by default. `auto` (instant)
   * for a host whose content can land ABOVE the target while it scrolls (one
   * that loads older content as the top nears): a smooth scroll aims at an
   * offset fixed when it starts, which that content moves.
   */
  revealBehavior?: ScrollBehavior;
  /** Extra affordance pinned under the expanded panel's list. */
  footer?: ReactNode;
  /** Accessible name of the `<nav>`. Defaults to "Outline". */
  label?: string;
}

/**
 * Notion's right-edge minimap: a stack of dashes, one per section, the current
 * one bright and wide; hover / focus / tap expands it into the outline itself,
 * indented by depth, and a click jumps.
 *
 * The host owns only WHAT the entries are and HOW an id maps to a DOM node —
 * the parts that legitimately differ between a transcript and a page. Everything
 * else (which entry is current, the disclosure, the overflow window, the
 * scroll-to) belongs here.
 *
 * **The host must establish the positioning context**: the rail pins itself to
 * the right edge of its nearest `relative` ancestor, so mount it inside one that
 * spans the scrolling surface.
 */
export function OutlineRail(props: OutlineRailProps): ReactElement | null {
  // A one-section outline is noise, and the gate sits above every hook so the
  // list below never has to represent "too short" as an empty rail.
  if (props.entries.length < 2) return null;
  return <OutlineRailBody {...props} />;
}

function OutlineRailBody({
  entries,
  resolve,
  onUnmounted,
  revealBehavior = "smooth",
  footer,
  label,
}: OutlineRailProps): ReactElement {
  const ids = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const activeId = useActiveInView(ids, resolve);

  // Measure the POSITIONING HOST, not ourselves: the rail's height is its own
  // dash count, so asking it how much room it has would be circular. The rail is
  // absolutely positioned, so its offset parent is exactly the host that spans
  // the surface.
  const [railRef, hostSize] = useElementSize<HTMLElement>(
    (el) => el.offsetParent,
  );
  const capacity = Math.max(
    0,
    Math.floor((hostSize.height - RAIL_RESERVE_PX) / DASH_STEP_PX),
  );

  const jump = useCallback(
    (id: string) => {
      const element = resolve(id);
      if (element === null && onUnmounted) onUnmounted(id);
      else revealElement(element, { behavior: revealBehavior, block: "start" });
    },
    [resolve, onUnmounted, revealBehavior],
  );

  const activeIndex = Math.max(
    0,
    entries.findIndex((entry) => entry.id === activeId),
  );

  return (
    <Pin
      ref={railRef}
      as="nav"
      // The top corner, not the vertical middle: the rail is the document's
      // index, so it hangs from where the document starts and grows downward
      // with it. Centered, a short outline floats in the middle of an empty
      // margin with nothing to relate to.
      to="top-right"
      offset="sm"
      layer="float"
      data-outline-rail=""
      aria-label={label ?? "Outline"}
    >
      {/* Held back until the host has been measured: before that the capacity
          is 0 and the rail would mount as an empty stack. (`FloatingAction`
          re-sizes its hover hitbox as the dash count changes, so nothing here
          has to arrive at its final size.) */}
      {capacity > 0 ? (
        <FloatingAction
          // Ghost, not the default outlined: at rest this is a row of tick
          // marks floating against the page, with no border, background or
          // shadow of its own — a box around them reads as a widget parked in
          // the margin rather than an edge indicator. The chrome arrives with
          // the panel, which is a surface and should look like one.
          variant="ghost"
          anchor="top-right"
          // A column with the dash stack above the outline (`triggerAt`
          // defaults to `start`, and the dashes are the trigger).
          direction="col"
          // The panel's collapsed→open morph, which the primitive animates but
          // does not size.
          panelClassName={cn("w-8 group-data-open/fa:w-56")}
          trigger={
            // The panel REPLACES the dashes, as Notion's does — left in place
            // they sit as a dead band across the open panel's top and push the
            // outline down. Clipped to zero height, never unmounted: a dash's
            // `data-active` is the rail's published answer to "where am I",
            // read while the panel is open. (Clipping it does not shrink
            // `FloatingAction`'s hover hitbox: the hitbox follows the trigger
            // only while the panel is closed, so it holds still under the
            // pointer while the panel morphs.)
            <Clip className="group-data-open/fa:max-h-0">
              <DashStack
                entries={entries}
                activeId={activeId}
                activeIndex={activeIndex}
                capacity={capacity}
                onJump={jump}
              />
            </Clip>
          }
        >
          {/* The panel's collapsed height must be the dash stack's, so the list
              is clamped to zero rather than the panel to a guessed height — the
              stack's height varies with the pane and no class can name it. */}
          <Clip className="max-h-0 w-56 transition-[max-height] duration-200 ease-out group-data-open/fa:max-h-80">
            <Column
              className="max-h-80"
              body={
                <FloatingActionFadeIn>
                  {
                    // transient navigation chrome
                    entries.map((entry) => (
                      <OutlineRow
                        key={entry.id}
                        entry={entry}
                        active={entry.id === activeId}
                        onJump={jump}
                      />
                    ))
                  }
                </FloatingActionFadeIn>
              }
              footer={
                footer ? (
                  <FloatingActionFadeIn>
                    {/* The slot is the panel's whole width and centers what it
                        holds. A footer affordance is the one control in the
                        panel with no row of its own to sit on, so left where it
                        falls it is a 2rem box in the corner of a 14rem panel —
                        a target you aim at rather than one you hit. A footer
                        that takes the full width (`w-full`) fills the row;
                        anything narrower is centered in it. */}
                    <Stack direction="row" gap="none" justify="center">
                      {footer}
                    </Stack>
                  </FloatingActionFadeIn>
                ) : undefined
              }
            />
          </Clip>
        </FloatingAction>
      ) : null}
    </Pin>
  );
}
