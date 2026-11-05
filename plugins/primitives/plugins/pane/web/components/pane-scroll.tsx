import { Scroll, type ScrollProps } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useScrollAcrossReload } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useMemo, type Ref, type RefCallback } from "react";
import { usePaneInstanceKey } from "../pane";

/**
 * `PaneScroll` props mirror `Scroll` minus the two axes the pane body fixes:
 * `axis` (always `"y"`) and `fill` (always on, so the viewport claims the pane's
 * leftover height and the overflow engages). Everything else — `hideScrollbar`,
 * `isolate`, `as`, `ref`, `className`, `children` — forwards straight through.
 */
export type PaneScrollProps = Omit<ScrollProps, "axis" | "fill">;

/**
 * The single sanctioned pane-body vertical scroll viewport — a dead-thin
 * `<Scroll axis="y" fill h-full>`. A pane body is exactly one `PaneScroll`; every
 * header inside it is a `<Sticky>`. Routing every pane body through this one idiom
 * makes "the pane owns exactly one scroll" a grep/doc target and keeps
 * `VirtualRows.findScrollParent` binding to a predictable viewport.
 *
 * It keeps its offset across a page reload (auto-scroll's
 * `useScrollAcrossReload`), keyed by the pane instance it is drawn in — tab,
 * pane, address and views — so a reloaded page opens where the reader left it.
 *
 * It forwards `ref` (consumers may need the scroll-container element), `as`,
 * `hideScrollbar`, `isolate`, and composes `className` last.
 */
export function PaneScroll({ className, ref, ...rest }: PaneScrollProps) {
  const keep = useScrollAcrossReload(usePaneInstanceKey());
  // Stable across renders: a new callback ref would detach and re-attach the
  // scroller on every render.
  const scrollRef = useMemo(() => bothRefs(keep, ref), [keep, ref]);
  return (
    <Scroll
      axis="y"
      fill
      className={cn("h-full", className)}
      ref={scrollRef}
      {...rest}
    />
  );
}

function bothRefs(
  own: RefCallback<HTMLElement>,
  theirs: Ref<HTMLElement> | undefined,
): RefCallback<HTMLElement> {
  return (el) => {
    own(el);
    if (typeof theirs === "function") theirs(el);
    else if (theirs) theirs.current = el;
  };
}
