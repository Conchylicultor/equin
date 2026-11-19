import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import {
  announceNavigation,
  findScrollParent,
  keepInPlace,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useInView } from "@plugins/primitives/plugins/dom/plugins/in-view/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import {
  SectionExpandProvider,
  SectionStartProvider,
} from "./section-sticky-context";
import { paneScrollScope } from "./pane-scroll-scope";
import { useTranscriptDrawn } from "./transcript-events-context";

/**
 * A turn's section: the prompt that opens it (`header`), pinned to the top of
 * the pane while the turn (`children`) scrolls under it. Shared by the
 * transcript's own sections and a sent turn's echo (`EchoRow`), so the two wear
 * the same chrome.
 *
 * It also tells the prompt's row where the prompt starts (`useSectionStart`):
 * a marker at the section's top edge — the prompt's place in the flow, which
 * the pinned prompt has left — is watched against the transcript's viewport,
 * so the row can offer to jump back to it once it is scrolled out.
 */
export function TurnSection({
  header,
  children,
}: {
  header: ReactNode;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const startRef = useRef<HTMLElement>(null);

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

  const expand = useMemo(
    () => ({ expanded, setExpanded: setExpandedInPlace }),
    [expanded, setExpandedInPlace],
  );

  // The marker's top is the prompt's first line in the flow. Above the
  // viewport's top edge (not intersecting, and above rather than below) the
  // prompt's start is out of view — whether pinned over its turn or expanded
  // and read past. Landing exactly on the edge (a jump's end) touches it, so
  // it is in view again.
  const scroller = paneScrollScope.useRoot();
  const root = scroller.attached ? scroller.root : null;
  const [scrolledPast, setScrolledPast] = useState(false);
  useInView(
    () => (root === null ? null : startRef.current),
    (entry) => {
      const bounds = entry.rootBounds;
      setScrolledPast(
        !entry.isIntersecting &&
          bounds !== null &&
          entry.boundingClientRect.bottom <= bounds.top,
      );
    },
    { root, deps: [root] },
  );

  // A window loads older pages as its top nears, which would move the target
  // under a smooth scroll already under way — so a paged transcript jumps.
  const { older } = useTranscriptDrawn();
  const jump = useCallback(() => {
    revealElement(sectionRef.current, {
      behavior: older ? "auto" : "smooth",
      block: "start",
      scope: "nearest",
    });
  }, [older]);
  const start = useMemo(() => ({ scrolledPast, jump }), [scrolledPast, jump]);

  return (
    // `relative`: the start marker is placed against the section's own box.
    <Stack ref={sectionRef} gap="sm" className="relative">
      <Pin
        ref={startRef}
        to="top"
        stretch
        decorative
        aria-hidden
        className="h-px"
      />
      <SectionExpandProvider value={expand}>
        <SectionStartProvider value={start}>
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
            {header}
          </Sticky>
        </SectionStartProvider>
      </SectionExpandProvider>
      {children}
    </Stack>
  );
}
