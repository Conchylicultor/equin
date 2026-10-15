import type { ReactNode } from "react";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";

/** The data attribute every host carries — what the pressed rule keys on. */
const HOST_ATTR = "data-hover-expand-host";
/** The data attribute a host carries while something inside it is held open. */
const HELD_ATTR = "data-hover-expand-held";

/**
 * Spread onto the box whose hover / focus opens a {@link HoverExpandPanel} — the
 * whole control (icon, readout, panel), so pointing at any of it opens it.
 *
 * `held` keeps the panel open whatever the pointer does: a jog wheel passes
 * "its drag is not idle", so a flick that leaves the control, or a coast after
 * release, never collapses the face under the user's hand. (A native drag — the
 * volume slider's — needs nothing: the panel stays open while anything inside
 * the host is `:active`.)
 */
export function hoverExpandHost(held = false): {
  className: string;
  [HOST_ATTR]: "";
  [HELD_ATTR]?: "true";
} {
  const host = { className: "group/hover-expand", [HOST_ATTR]: "" } as const;
  return held ? { ...host, [HELD_ATTR]: "true" } : host;
}

/**
 * The part of a toolbar control that is folded away at rest and opens out while
 * its host ({@link hoverExpandHost}) is hovered, has focus within, has a
 * pointer pressed inside it, or is held. The ONE open/closed rule every
 * collapsible Sonata toolbar control uses — the jog wheels' ribbed face and the
 * volume slider — so they all open and close alike.
 *
 * It animates to its content's own width (a `0fr → 1fr` grid track), so the
 * caller sizes the content and never restates that size here. Folded, the
 * content is still in the DOM and focusable — tabbing onto it is one of the
 * ways it opens.
 */
export function HoverExpandPanel({ children }: { children: ReactNode }) {
  return (
    <div
      // eslint-disable-next-line layout/no-adhoc-layout -- the fold is a one-column grid whose track animates 0fr → 1fr, so the panel opens to its content's own width with no width restated here; no layout primitive owns an animatable track
      className={cn(
        // Folded, it is no click-target either: opacity and pointer-events
        // move together, so nothing invisible can be pressed.
        "pointer-events-none grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none",
        "group-hover/hover-expand:pointer-events-auto group-hover/hover-expand:grid-cols-[1fr] group-hover/hover-expand:opacity-100",
        "group-focus-within/hover-expand:pointer-events-auto group-focus-within/hover-expand:grid-cols-[1fr] group-focus-within/hover-expand:opacity-100",
        // Pressed inside: `[host]:has(:active) <this panel>`, never Tailwind's
        // `group-has-*`, whose `:is(.group:has(…) *)` makes Chrome restyle the
        // whole subtree under every `:has()`-flagged ancestor on each DOM
        // insertion or removal anywhere in the app.
        "[[data-hover-expand-host]:has(:active)_&]:pointer-events-auto [[data-hover-expand-host]:has(:active)_&]:grid-cols-[1fr] [[data-hover-expand-host]:has(:active)_&]:opacity-100",
        "group-data-[hover-expand-held=true]/hover-expand:pointer-events-auto group-data-[hover-expand-held=true]/hover-expand:grid-cols-[1fr] group-data-[hover-expand-held=true]/hover-expand:opacity-100",
      )}
    >
      {/* The track's one cell: yields below its content so a 0fr track can
          fold it, and clips what the fold hides. */}
      <Clip className={yieldClass("x")}>{children}</Clip>
    </div>
  );
}
