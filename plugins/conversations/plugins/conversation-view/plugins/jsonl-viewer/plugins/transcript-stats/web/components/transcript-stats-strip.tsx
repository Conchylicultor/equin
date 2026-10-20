import { useCallback, useMemo } from "react";
import { Pin } from "@plugins/primitives/plugins/css/plugins/pin/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useActiveInView } from "@plugins/primitives/plugins/outline/plugins/scroll-spy/web";
import {
  paneScrollScope,
  useTranscriptDrawn,
  useVisibleEvents,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { TranscriptStats } from "../slots";
import { TranscriptReadProvider } from "../read-context";
import { StatBadge } from "./stat-badge";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

const historyIcon = symbol("history");

export function TranscriptStatsStrip() {
  // The transcript the enclosing view draws — the conversation's own, or a
  // sub-agent's — never a re-fetch by conversation id, which inside a
  // sub-agent pane would name the PARENT and report its numbers instead.
  const { events, firstSeq } = useTranscriptDrawn();
  // This strip is a sibling of the transcript scroller inside the pane frame,
  // not inside it, so the scroller has to be published rather than walked to.
  const scroller = paneScrollScope.useRoot();
  // The DOM numbers rows over the FILTERED transcript, so the anchor comes back
  // in those terms and has to be translated before it can slice the raw one.
  const visible = useVisibleEvents(events);
  // The candidates ARE the rows currently in the transcript, so a torn-out row
  // cannot pin the anchor past the end — no staleness guard needed downstream.
  const ids = useMemo(() => visible.map((_, i) => String(i)), [visible]);
  const resolve = useCallback(
    // Not-attached-yet is one commit, not "no rows": the strip re-enrols when
    // the transcript appears. A null from the query is a genuinely absent row.
    (id: string) =>
      scroller.attached
        ? scroller.root.querySelector(`[data-event-index="${CSS.escape(id)}"]`)
        : null,
    [scroller],
  );
  const anchorId = useActiveInView(ids, resolve, { position: "furthest-read" });
  const anchor = anchorId === null ? null : Number(anchorId);

  const read = useMemo(() => {
    const anchorEvent = anchor === null ? undefined : visible[anchor];
    // No anchor yet (first paint) or a row that is no longer in the transcript:
    // the honest answer is the whole thing, which is also what the strip showed
    // before it could follow the reader at all.
    if (!anchorEvent) return { events, firstSeq, atEnd: true };
    // Identity, not position: `visible` is a subsequence of `events` sharing its
    // element references, so this is exact where an index would be off by every
    // hidden row before it.
    const rawIndex = events.indexOf(anchorEvent);
    if (rawIndex < 0) return { events, firstSeq, atEnd: true };
    const atEnd = rawIndex === events.length - 1;
    return {
      events: atEnd ? events : events.slice(0, rawIndex + 1),
      firstSeq,
      atEnd,
    };
  }, [events, firstSeq, visible, anchor]);

  return (
    <Pin to="bottom" stretch offset="sm" layer="raised" decorative>
      <Stack
        direction="row"
        justify="end"
        align="center"
        gap="xs"
        className="mx-auto max-w-reading px-md"
      >
        {/* Scrolled back into history, the numbers beside this are no longer
            the conversation's totals — they are what they were at the row on
            screen. Without something saying so, a reader who scrolls up just
            sees the counters move for no reason. */}
        {!read.atEnd && (
          <StatBadge tooltip="Showing the transcript up to the last row on screen. Scroll to the end for the totals.">
            <Icon icon={historyIcon} className="size-3" />
          </StatBadge>
        )}
        <TranscriptReadProvider value={read}>
          <TranscriptStats.Item.Render />
        </TranscriptReadProvider>
      </Stack>
    </Pin>
  );
}
