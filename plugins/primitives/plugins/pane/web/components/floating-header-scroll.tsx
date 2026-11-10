import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useElementSize } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { useInView } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { PaneScroll } from "./pane-scroll";

/**
 * The pane's one scroll with its header floating over the top of it — the body
 * of a `<PaneChrome floatingHeader>`.
 *
 * The header is the scroll's first child, pinned to its top edge, so the page
 * can run up behind it. It is see-through while the body sits at its top and
 * masks what scrolls under it once anything does: `header(atTop)` is told
 * which, so the bar can drop its rule while there is nothing to separate.
 *
 * "At the top" is read from a zero-height marker at the head of the scrolled
 * content, watched against the scroll itself: it is in view exactly while the
 * scroll offset is zero. An observer, not a scroll listener — it delivers only
 * when the answer changes.
 *
 * `theme` is the theme scope the header wears, which the page may change as it
 * scrolls (the website's iceberg: the sky's ink over the sky, the sea's once
 * the waterline has passed under the bar). The bar then masks with that
 * theme's own background, not the page's. `glass` frosts the mask instead of
 * painting it opaque.
 *
 * The bar's height is published on the scroll: as its `scroll-padding-top`,
 * so a reveal inside (`revealElement`, `scrollIntoView`) lands below the bar
 * rather than under it, and as `--pane-header-height`, for a page sizing
 * something to what the bar leaves of the window.
 *
 * The body is sealed in its own stacking context (`isolate`), so the header
 * paints over it whatever z-index the page gives its own pieces: a page's
 * layers (the vision zoom's copy over its pinned stage) order among themselves
 * and never against the bar — a tie with the bar's layer would otherwise put a
 * later-in-DOM page layer on top of it, its text showing through the mask.
 */
export function FloatingHeaderScroll({
  header,
  theme,
  glass = false,
  children,
}: {
  header: (atTop: boolean) => ReactNode;
  /** The theme scope the header wears (`PaneChrome headerTheme`). */
  theme?: string;
  /** Frost the mask instead of painting it opaque (`PaneChrome headerGlass`). */
  glass?: boolean;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  // Every scroll opens at its top, and the first delivery confirms or corrects
  // it within a frame.
  const [atTop, setAtTop] = useState(true);
  useInView(topRef, (entry) => setAtTop(entry.isIntersecting), {
    root: scrollRef,
  });
  const [barRef, barSize] = useElementSize<HTMLDivElement>();
  const bar = (
    <Sticky
      ref={barRef}
      mask={atTop ? false : glass ? "glass" : true}
      className={cn(
        "transition-colors",
        // the bar masks with the background of the theme it wears, which the
        // boundary around it re-themes but (painting nothing) does not publish
        theme !== undefined && "[--chrome-mask:var(--background)]",
      )}
    >
      {header(atTop)}
    </Sticky>
  );
  return (
    <PaneScroll
      ref={scrollRef}
      style={
        {
          scrollPaddingTop: barSize.height,
          "--pane-header-height": `${barSize.height}px`,
        } as CSSProperties
      }
    >
      <div ref={topRef} aria-hidden />
      {theme === undefined ? (
        bar
      ) : (
        <Theme name={theme} surface="none" className="contents">
          {bar}
        </Theme>
      )}
      <div className="isolate h-full">{children}</div>
    </PaneScroll>
  );
}
