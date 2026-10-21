import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { SectionExpandProvider } from "./section-sticky-context";

/**
 * The prompt that opens a turn's section, pinned to the top of the pane while
 * the turn scrolls under it. Shared by the transcript's own prompt rows and a
 * sent turn's echo (`EchoRow`), so the two wear the same chrome.
 */
export function StickyUserHeader({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const value = useMemo(() => ({ expanded, setExpanded }), [expanded]);
  // A pinned turn loses `position: sticky` the moment it expands, so it snaps
  // back to its natural scroll position — which sits above the viewport and
  // carries the just-expanded message out of view. Scroll it back to the top of
  // the pane so it stays where the user was looking. Stickiness is toggled via
  // the `active` prop on a single stable element (never by swapping element
  // types), so the subtree never remounts.
  useLayoutEffect(() => {
    if (expanded)
      revealElement(ref.current, { behavior: "smooth", block: "start" });
  }, [expanded]);
  return (
    <SectionExpandProvider value={value}>
      <Sticky
        ref={ref}
        data-pinned-header=""
        active={!expanded}
        edge="top"
        layer="nav"
        className={`bg-background pb-2xs ${expanded ? "z-raised" : "shadow-[0_2px_6px_-2px_rgba(0,0,0,0.1)]"}`}
      >
        {children}
      </Sticky>
    </SectionExpandProvider>
  );
}
