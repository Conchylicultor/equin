import { useRef, type ReactNode } from "react";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { FOLLOW_MOTION_ATTR } from "@plugins/primitives/plugins/dom/plugins/auto-scroll/web";
import { useResizeObserver } from "@plugins/primitives/plugins/dom/plugins/element-size/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useStreamingStandIns } from "../use-streaming-stand-ins";
import { EventRow } from "./event-row";
import { StreamingRowProvider } from "./streaming-row-context";
import { useTranscriptEvents } from "./transcript-events-context";
import "./streaming-message.css";

/**
 * The message the agent is writing — its thinking, text and tool calls — drawn
 * at the end of the transcript as the model streams it: each block a stand-in
 * through the renderer its row will use, in block order, until the transcript
 * holds that block (`useStreamingStandIns`).
 */
export function StreamingMessage({
  conversationId,
}: {
  conversationId: string;
}) {
  const events = useTranscriptEvents();
  const streaming = useStreamingStandIns(conversationId, events);
  switch (streaming.status) {
    case "unavailable":
      // No computer behind this page (the demo): no agent is writing.
      return null;
    case "loading":
      // Not known yet: nothing is drawn — exactly what the transcript shows
      // until a finished row lands, so nothing reverses itself.
      return null;
    case "error":
      return (
        <ResourceErrorInline
          variant="inline"
          subject="the message being written"
          error={streaming.error}
          refetch={streaming.refetch}
        />
      );
    case "ready":
      break;
  }
  if (streaming.data === null || streaming.data.standIns.length === 0)
    return null;
  const { messageId, standIns } = streaming.data;
  return (
    // Per message: a new message's frame eases from nothing.
    <EasedHeight key={messageId}>
      {/* The attributes mark the message and each stand-in for the e2e
          scripts (assistant-text/e2e/first-token.ts, e2e/stream-order.ts). */}
      <Stack gap="sm" data-streaming-message={messageId}>
        {standIns.map((s) => (
          <div key={s.key} data-stand-in={s.event.kind}>
            <StreamingRowProvider writing={s.writing}>
              <EventRow event={s.event} standIn />
            </StreamingRowProvider>
          </div>
        ))}
      </Stack>
    </EasedHeight>
  );
}

/**
 * Eases to its content's height as it grows — so the transcript glides rather
 * than stepping a line at a time. Stamped `FOLLOW_MOTION_ATTR`, so a
 * transcript following the bottom follows the easing frame by frame.
 */
function EasedHeight({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useResizeObserver(
    content,
    () => {
      const outer = frame.current;
      const inner = content.current;
      if (outer && inner) outer.style.height = `${inner.offsetHeight}px`;
    },
    // Undebounced: the easing starts on the frame the content grew.
    { debounce: false },
  );
  return (
    <div
      ref={frame}
      className="streaming-message-frame"
      {...{ [FOLLOW_MOTION_ATTR]: "" }}
    >
      <div ref={content}>{children}</div>
    </div>
  );
}
