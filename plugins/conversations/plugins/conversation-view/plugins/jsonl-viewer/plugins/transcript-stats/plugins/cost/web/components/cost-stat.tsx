import { useState } from "react";
import {
  conversationCostByHour,
  conversationUsageById,
  costAtInstant,
  hourStartOf,
} from "@plugins/conversations/plugins/usage/core";
import type { JsonlEvent } from "@plugins/conversations/plugins/transcript-source/core";
import {
  useJsonlConversationId,
  useTranscriptSubject,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  StatBadge,
  useTranscriptRead,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { formatUsd } from "./format-usd";

/**
 * What the session had cost at API prices by the row the reader is on: the
 * conversation's own transcripts plus every sub-agent it launched, a
 * sub-agent's spend counted when it happened. At the end of the transcript it
 * is the totals the usage sync last counted; scrolled back, the cost at the
 * last visible row's instant, priced from the hour it falls in
 * (`conversationCostByHour`, one key per hour: scrolling within an hour reads
 * no new key) — so scrolling walks the number back with the other readings.
 *
 * Only in the conversation's own transcript: a sub-agent's pane would name the
 * parent's total.
 */
export function CostStat() {
  const conversationId = useJsonlConversationId();
  const subject = useTranscriptSubject();
  if (conversationId === null || subject.kind !== "conversation") return null;
  return <CostStatFor conversationId={conversationId} />;
}

function CostStatFor({ conversationId }: { conversationId: string }) {
  const { events, atEnd } = useTranscriptRead();
  if (atEnd) return <TotalCost conversationId={conversationId} />;
  const at = readingInstant(events);
  // Scrolled back past every timestamped row: no reading position to price.
  if (at === null) return null;
  return <CostAt conversationId={conversationId} at={at} />;
}

/** The instant of the last visible row that has one (a synthetic row may not). */
function readingInstant(events: readonly JsonlEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const at = events[i]!.at;
    if (at !== "" && !Number.isNaN(Date.parse(at))) return at;
  }
  return null;
}

const HINT =
  "At API prices — this conversation and every sub-agent it launched. Tokens are input, output and cache writes.";

function TotalCost({ conversationId }: { conversationId: string }) {
  const read = useLive(conversationUsageById, { id: conversationId });
  // A reading in the strip: nothing until it is known.
  if (read.status === "loading") return null;
  if (read.status === "error")
    return (
      <StatBadge tone="alert" tooltip={read.error.message}>
        cost unavailable
      </StatBadge>
    );
  // `found: false` is determinate: the sync has not counted this conversation
  // yet (it counts on the first transcript append).
  if (!read.found) return null;
  const { costUsd, tokens, cacheReadTokens, agentCount } = read.row;
  return (
    <StatBadge
      card={{
        title: "API cost",
        figures: {
          rows: [
            { label: "Cost", value: formatUsd(costUsd, "exact") },
            { label: "Sub-agents", value: agentCount.toLocaleString() },
            { label: "Tokens", value: Math.round(tokens).toLocaleString() },
            {
              label: "Cache reads",
              value: Math.round(cacheReadTokens).toLocaleString(),
            },
          ],
        },
        hint: `The whole session so far. ${HINT}`,
      }}
    >
      {formatUsd(costUsd, "short")}
    </StatBadge>
  );
}

interface Shown {
  at: string;
  costUsd: number;
  unpricedModels: readonly string[];
}

function CostAt({
  conversationId,
  at,
}: {
  conversationId: string;
  at: string;
}) {
  const instant = Date.parse(at);
  const read = useLive(conversationCostByHour, {
    id: conversationId,
    hour: hourStartOf(instant),
  });
  // While a new hour loads, the strip keeps the last position it priced — the
  // reading moves as the reader scrolls, so blanking it at an hour boundary
  // would flicker. Before any is known it shows nothing.
  const [shown, setShown] = useState<Shown | null>(null);
  if (read.status === "ready") {
    const priced = costAtInstant(read.data, instant);
    if (
      shown === null ||
      shown.at !== at ||
      shown.costUsd !== priced.costUsd ||
      shown.unpricedModels.join() !== priced.unpricedModels.join()
    ) {
      setShown({ at, ...priced });
    }
  }
  // The demo's in-browser server has no transcripts on disk to read.
  if (read.status === "unavailable") return null;
  if (read.status === "error")
    return (
      <StatBadge tone="alert" tooltip={read.error.message}>
        cost unavailable
      </StatBadge>
    );
  if (shown === null) return null;
  const unpriced = shown.unpricedModels.length > 0;
  return (
    <StatBadge
      tone={unpriced ? "attention" : "muted"}
      card={{
        title: "API cost",
        figures: {
          rows: [
            { label: "Cost", value: formatUsd(shown.costUsd, "exact") },
            {
              label: "By",
              value: new Date(shown.at).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            },
            ...(unpriced
              ? [
                  {
                    label: "No price for",
                    value: shown.unpricedModels.join(", "),
                  },
                ]
              : []),
          ],
        },
        hint: `Up to the last row on screen. ${HINT}`,
      }}
    >
      {formatUsd(shown.costUsd, "short")}
    </StatBadge>
  );
}
