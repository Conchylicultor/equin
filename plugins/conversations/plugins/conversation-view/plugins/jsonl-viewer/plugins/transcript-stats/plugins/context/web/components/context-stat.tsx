import { useState } from "react";
import {
  conversationContextUsage,
  type ContextUsage,
} from "@plugins/conversations/plugins/context-usage/core";
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
import { InlinePopover } from "@plugins/primitives/plugins/overlay/plugins/popover/web";
import { ContextCard } from "./context-card";
import { contextLimit } from "./context-math";

/**
 * The context ring at the end of the strip: how full the agent's window is
 * against the point the harness compacts it, as the harness itself last
 * measured it (the agent reports a reading once ready and after every turn) —
 * not at the reading position, since the window has only a present.
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
  const read = useLive(conversationContextUsage, { id: conversationId });
  const [open, setOpen] = useState(false);
  // A reading in the strip: nothing until it is known.
  if (read.status === "loading") return null;
  if (read.status === "error")
    return (
      <StatBadge tone="alert" tooltip={read.error.message}>
        context unavailable
      </StatBadge>
    );
  // `found: false` is determinate: the agent has reported no reading yet.
  const usage = read.found ? read.row.usage : null;
  return (
    <InlinePopover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="end"
      width="xl"
      trigger={
        <StatBadge
          as="button"
          tone={toneOf(usage)}
          aria-label="Context window"
          tooltip={tooltipOf(usage)}
        >
          <Ring usage={usage} />
        </StatBadge>
      }
    >
      <ContextCard
        conversationId={conversationId}
        usage={usage}
        onCompacted={() => setOpen(false)}
      />
    </InlinePopover>
  );
}

function fractionOf(usage: ContextUsage | null): number | null {
  if (usage === null) return null;
  return Math.min(1, usage.totalTokens / contextLimit(usage));
}

function toneOf(usage: ContextUsage | null): StatTone {
  const fraction = fractionOf(usage);
  if (fraction === null) return "muted";
  if (fraction >= 0.9) return "alert";
  if (fraction >= 0.75) return "attention";
  return "muted";
}

function tooltipOf(usage: ContextUsage | null): string {
  if (usage === null) return "Context window — compact";
  const { totalTokens, rawMaxTokens } = usage;
  return `Context: ${formatTokenCount(totalTokens)} / ${formatTokenCount(rawMaxTokens)}`;
}

const RADIUS = 5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A 12px ring in the badge's ink: a faint track, the used share drawn over it. */
function Ring({ usage }: { usage: ContextUsage | null }) {
  const fraction = fractionOf(usage) ?? 0;
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
