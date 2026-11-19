import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import {
  announceNavigation,
  findScrollParent,
  keepInPlace,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { SectionExpandProvider } from "./section-sticky-context";

/**
 * The prompt that opens a turn's section, pinned to the top of the pane while
 * the turn scrolls under it. Shared by the transcript's own prompt rows and a
 * sent turn's echo (`EchoRow`), so the two wear the same chrome.
 */
export function StickyUserHeader({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // A pinned prompt loses `position: sticky` the moment it expands, so it
  // would snap back to its natural place in the flow — far above the viewport
  // in a long turn, carrying the just-expanded message out of view. It is
  // kept where it is on screen instead, in the same frame: the reader opened
  // it there. Never a scroll TO its natural place: in a paged transcript that
  // place is next to the top sentinel (a window opening mid-turn draws the
  // turn's prompt ahead of it), so a smooth scroll travelling there loads
  // older pages, which land below the prompt and push it away while the
  // scroll heads for where it used to be — the reader ended in the loaded
  // rows, never on the message.
  //
  // The expand is the reader's own action, so it is announced: a transcript
  // following its bottom hands the offset over rather than writing the bottom
  // back over it. Collapsing re-pins it, and needs nothing.
  const setExpandedInPlace = useCallback((next: boolean) => {
    const el = ref.current;
    if (!next || el === null) {
      setExpanded(next);
      return;
    }
    announceNavigation(el);
    keepInPlace(findScrollParent(el), el, () =>
      flushSync(() => setExpanded(true)),
    );
  }, []);

  const value = useMemo(
    () => ({ expanded, setExpanded: setExpandedInPlace }),
    [expanded, setExpandedInPlace],
  );
  return (
    <SectionExpandProvider value={value}>
      <Sticky
        ref={ref}
        // Only a PINNED prompt is a weak anchor (it does not move when content
        // lands above it, so it names the section's start, not the row being
        // read). Expanded, it is an ordinary row in the flow — the one being
        // read — and the anchor that keeps it still as older pages land below it.
        data-pinned-header={expanded ? undefined : ""}
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
