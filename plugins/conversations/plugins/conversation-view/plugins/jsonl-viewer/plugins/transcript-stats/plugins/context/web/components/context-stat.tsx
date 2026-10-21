import { useState } from "react";
import {
  conversationContextUsage,
  type ContextReading,
} from "@plugins/conversations/core";
import {
  formatTokenCount,
  useJsonlConversationId,
  useTranscriptSubject,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  StatBadge,
  type StatTone,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { ContextCard } from "./context-card";
import { contextLimit } from "./context-math";

/**
 * The context ring at the end of the strip: how full the agent's window is
 * against the point the harness compacts it, as the harness itself measures
 * it now — not at the reading position, since the window has only a present.
 * Opens the breakdown and the Compact action.
 *
 * Only in the conversation's own transcript: a sub-agent's pane would name the
 * parent's window.
 */
export function ContextStat() {
  const conversationId = useJsonlConversationId();
  const subject = useTranscriptSubject();
  if (conversationId === null || subject.kind !== "conversation") return null;
  return <ContextStatFor conversationId={conversationId} />;
}

function ContextStatFor({ conversationId }: { conversationId: string }) {
  const reading = useLive(conversationContextUsage, { id: conversationId });
  const [open, setOpen] = useState(false);
  // A reading in the strip: nothing until it is known.
  return matchResource(reading, {
    loading: () => null,
    error: (err) => (
      <StatBadge tone="alert" tooltip={err.message}>
        context unavailable
      </StatBadge>
    ),
    ready: (value) => (
      <InlinePopover
        open={open}
        onOpenChange={setOpen}
        side="top"
        align="end"
        width="xl"
        trigger={
          <StatBadge
            as="button"
            tone={toneOf(value)}
            aria-label="Context window"
            tooltip={tooltipOf(value)}
          >
            <Ring reading={value} />
          </StatBadge>
        }
      >
        <ContextCard
          conversationId={conversationId}
          reading={value}
          onCompacted={() => setOpen(false)}
        />
      </InlinePopover>
    ),
  });
}

function fractionOf(reading: ContextReading): number | null {
  if (reading.kind !== "ready") return null;
  return Math.min(1, reading.usage.totalTokens / contextLimit(reading.usage));
}

function toneOf(reading: ContextReading): StatTone {
  const fraction = fractionOf(reading);
  if (fraction === null) return "muted";
  if (fraction >= 0.9) return "alert";
  if (fraction >= 0.75) return "attention";
  return "muted";
}

function tooltipOf(reading: ContextReading): string {
  if (reading.kind !== "ready") return "Context window — compact";
  const { totalTokens, rawMaxTokens } = reading.usage;
  return `Context: ${formatTokenCount(totalTokens)} / ${formatTokenCount(rawMaxTokens)}`;
}

const RADIUS = 5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A 12px ring in the badge's ink: a faint track, the used share drawn over it. */
function Ring({ reading }: { reading: ContextReading }) {
  const fraction = fractionOf(reading) ?? 0;
  return (
    <svg
      viewBox="0 0 14 14"
      className="size-3 -rotate-90"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx={7} cy={7} r={RADIUS} opacity={0.3} />
      <circle
        cx={7}
        cy={7}
        r={RADIUS}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
      />
    </svg>
  );
}
