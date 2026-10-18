import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  JumpToBottomButton,
  useStickyScroll,
} from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";

import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-watcher/core";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Sticky } from "@plugins/primitives/plugins/css/plugins/sticky/web";
import { revealElement } from "@plugins/primitives/plugins/dom/plugins/scroll-reveal/web";
import { useSurfaceTabId } from "@plugins/primitives/plugins/scope/plugins/surface-id/web";
import { ImageGallery } from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import { EventRow } from "./event-row";
import { ConversationIdProvider } from "./conversation-id-context";
import {
  TranscriptSubjectProvider,
  type TranscriptSubject,
} from "./transcript-subject-context";
import { TranscriptEventsProvider } from "./transcript-events-context";
import { paneScrollScope } from "./pane-scroll-scope";
import { SectionExpandProvider } from "./section-sticky-context";
import { useVisibleEvents } from "../use-visible-events";
import { useContextRuns } from "../use-context-runs";
import type { ContextFoldPhase } from "../context-runs";
import { ContextFold } from "./context-fold";
import { eventKey } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/core";

function StickyUserHeader({ children }: { children: ReactNode }) {
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

const FOLD_LABEL: Record<ContextFoldPhase, string> = {
  session: "Session context",
  update: "Context update",
};

function EventSections({ events }: { events: JsonlEvent[] }) {
  const items = useContextRuns(events);
  // Sections open at each user prompt. A context run never contains one (a
  // prompt is conversation), so a prompt is always a plain event item.
  const sections = useMemo(() => {
    const result: { start: number; end: number }[] = [];
    let sectionStart = 0;
    for (let i = 1; i < items.length; i++) {
      const item = items[i]!;
      if (item.kind === "event" && events[item.index]?.kind === "user-text") {
        result.push({ start: sectionStart, end: i });
        sectionStart = i;
      }
    }
    if (items.length > 0) {
      result.push({ start: sectionStart, end: items.length });
    }
    return result;
  }, [items, events]);

  const membersOf = (indices: readonly number[]) =>
    indices.map((index) => ({ event: events[index]!, index }));

  const renderItem = (n: number) => {
    const item = items[n]!;
    if (item.kind === "fold") {
      const first = events[item.members[0]!]!;
      return (
        <div key={`fold:${item.members[0]}`} data-event-key={eventKey(first)}>
          <ContextFold
            label={FOLD_LABEL[item.phase]}
            members={membersOf(item.members)}
          />
        </div>
      );
    }
    const event = events[item.index]!;
    return (
      <EventRow
        key={event.kind === "tool-call" ? event.toolUseId : item.index}
        event={event}
        index={item.index}
        hosted={item.hosted && membersOf(item.hosted)}
      />
    );
  };

  return (
    // One ← / → set per pane, over the transcript's own images only: the
    // trailing children (working indicator, pending prompt and turns) and the
    // composer below the pane hold nothing that was sent yet.
    <ImageGallery>
      {sections.map((section) => {
        const first = items[section.start]!;
        // Keyed by the first EVENT's index, as before folding existed, so a run
        // forming or growing does not remount the sections after it.
        const key = first.kind === "fold" ? first.members[0]! : first.index;
        const opensWithPrompt =
          first.kind === "event" && events[first.index]?.kind === "user-text";
        if (!opensWithPrompt) {
          return (
            <Fragment key={key}>
              {Array.from({ length: section.end - section.start }, (_, j) =>
                renderItem(section.start + j),
              )}
            </Fragment>
          );
        }
        return (
          <Stack key={key} gap="sm">
            <StickyUserHeader>{renderItem(section.start)}</StickyUserHeader>
            {Array.from({ length: section.end - section.start - 1 }, (_, j) =>
              renderItem(section.start + 1 + j),
            )}
          </Stack>
        );
      })}
    </ImageGallery>
  );
}

export interface TranscriptViewProps {
  /** The transcript, unfiltered — the view applies the `EventFilter` set. */
  events: JsonlEvent[];
  /**
   * The conversation these rows belong to.
   *
   * Not "the conversation this pane is about": a sub-agent's transcript is its
   * own surface, but its rows were still produced under the parent
   * conversation, and that is what a row action (launching an agent about an
   * unhandled row) means by "which conversation".
   */
  conversationId: string;
  /**
   * Whose transcript `events` is — the conversation's own, or one of its
   * sub-agents'. Required, because the conversation id cannot tell them apart
   * (a sub-agent's rows carry its parent's), and an overlay that reads the
   * conversation's own data must know which agent it is annotating.
   */
  subject: TranscriptSubject;
  /**
   * What is on screen — `conversation-scroll:<id>`, `subagent-scroll:<id>`.
   *
   * Name only the subject: the view appends the surface tab itself, so two
   * panes showing the same transcript keep their own reading positions without
   * every caller having to remember to do that.
   */
  persistKey: string;
  /**
   * Changing this re-asserts follow-the-bottom — the user just acted (sent a
   * turn). Never wire it to "something started working": see `useStickyScroll`.
   */
  followKey?: number | string | boolean;
  /**
   * Shown in place of the rows when the transcript holds no visible events,
   * ahead of `children`. It sits in the reading column, which fills the pane:
   * give it `growClass()` to take the height. It is styled by the caller — the
   * view applies no typography of its own.
   */
  empty?: ReactNode;
  /**
   * Pinned beside the scroller, inside the pane's positioning frame — a
   * `JsonlViewer.Overlay` strip, or a surface's own. It sits inside the scroll
   * scope, so it can ask `paneScrollScope` for the viewport it annotates, and
   * `useTranscriptEvents()` for the transcript it annotates.
   */
  overlay?: ReactNode;
  /** Fade the transcript: its subject is no longer live (a gone run). */
  dimmed?: boolean;
  /** Appended after the last row, inside the scroller. */
  children?: ReactNode;
}

function TranscriptViewInner({
  events,
  persistKey,
  followKey,
  empty,
  overlay,
  dimmed,
  children,
}: Omit<TranscriptViewProps, "conversationId" | "subject">) {
  const surfaceTabId = useSurfaceTabId();

  // Plugin-contributed hide predicates, via the shared owner — every surface
  // that enumerates the transcript must agree on which events exist.
  const visibleEvents = useVisibleEvents(events);

  // Destructure at the call site: react-hooks/refs taints the handle object
  // (it carries scrollRef), so member access on it during render is flagged;
  // plain destructured locals are clean.
  //
  // No effect keyed on events.length any more: the hook watches its own bottom
  // sentinel, so new events, images loading and shiki resolving all settle
  // without this component knowing anything about it.
  const { scrollRef, bottomSentinel, isFollowing, jumpToBottom } =
    useStickyScroll({
      followKey,
      persist: {
        // Per surface, not just per subject: two panes can be open on the same
        // transcript and are allowed to sit at different positions.
        key: `${persistKey}:${surfaceTabId ?? "detached"}`,
        anchorAttr: "data-event-key",
      },
    });

  // One DOM node, two readers. The sticky-scroll hook drives the scroller; the
  // view also PUBLISHES it into `paneScrollScope` so overlay contributions —
  // which are siblings of the scroller, not children — can scope a query to this
  // transcript instead of rediscovering it with a DOM walk. A node takes
  // one `ref`, hence the fan-out. Publishing is a callback ref, so the element
  // attaching notifies the overlays without re-rendering the transcript.
  const publishPaneScroll = paneScrollScope.usePublishRef();
  const attachScroll = useCallback(
    (node: HTMLElement | null) => {
      // `Scroll` hands back the base element type while the sticky hook types its
      // ref to the div it renders — the same node either way, as when this was
      // `ref={scrollRef}`.
      scrollRef.current = node as HTMLDivElement | null;
      publishPaneScroll(node);
    },
    [scrollRef, publishPaneScroll],
  );

  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- relative+isolate positioning host that is also the flex-fill child of the transcript column; hosts the scroller plus the Pin'd overlays as siblings so they don't scroll
    <div className="relative min-h-0 flex-1 isolate">
      <Scroll
        axis="both"
        ref={attachScroll}
        data-pane-scroll
        className={`h-full transition-opacity ${dimmed ? "opacity-50" : ""}`}
      >
        {/* The reading column — ONE container whether or not there are rows,
            so `children` sit in the same place either way (a pending turn sent
            into an empty transcript lands where its real row will). It fills
            the scroller, so an `empty` that grows (`growClass()`) can centre
            itself in the pane rather than sit on its first line. */}
        <Stack
          gap="sm"
          className="mx-auto min-h-full max-w-reading p-sm pb-2xl"
        >
          {visibleEvents.length === 0 ? (
            empty
          ) : (
            <EventSections events={visibleEvents} />
          )}
          {children}
        </Stack>
        {/* Must stay the last child: it marks the true end of the content. */}
        {bottomSentinel}
      </Scroll>
      {overlay}
      <JumpToBottomButton
        handle={{ isFollowing, jumpToBottom }}
        // eslint-disable-next-line layout/no-adhoc-layout -- off-ramp corner pin on an external Button (self-renders null when hidden); bottom-12/right-4 are off the spacing ramp
        className="absolute bottom-12 right-4 z-nav"
      />
    </div>
  );
}

/**
 * A Claude transcript, drawn as the conversation draws it.
 *
 * This is the WHOLE rendering of a transcript — the filter set, the sticky
 * user-turn headers, the per-event rows and their action strips, the pane's
 * image gallery, stick-to-bottom scrolling and the jump-to-bottom button. Any
 * surface showing a transcript composes this one component, so "the sub-agent's
 * cards look like the conversation's cards" is true by construction rather than
 * by two copies happening to agree.
 *
 * Everything that is about a *particular* surface — where the events came from,
 * what chrome sits above and below, what pinned readings the pane carries — is
 * the caller's. `JsonlPane` is the conversation's composition of it.
 */
export function TranscriptView({
  conversationId,
  subject,
  ...props
}: TranscriptViewProps) {
  return (
    // Both scopes are declared HERE, not in `TranscriptViewInner`: a component
    // may not render a Provider and use it in its own body, and the inner view
    // is the one that publishes the scroller. The scroll scope belongs to this
    // component because it is the common ancestor of the element's owner (the
    // scroller) and its readers (the `overlay` siblings) — a surface composing
    // the view has nothing left to remember.
    <paneScrollScope.Provider>
      <ConversationIdProvider id={conversationId}>
        <TranscriptSubjectProvider subject={subject}>
          <TranscriptEventsProvider events={props.events}>
            <TranscriptViewInner {...props} />
          </TranscriptEventsProvider>
        </TranscriptSubjectProvider>
      </ConversationIdProvider>
    </paneScrollScope.Provider>
  );
}
