import { conversationUsageById } from "@plugins/conversations/plugins/usage/core";
import {
  useJsonlConversationId,
  useTranscriptSubject,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { StatBadge } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { formatUsd } from "./format-usd";

/**
 * What the session has cost so far at API prices: the conversation's own
 * transcripts plus every sub-agent it launched, as the usage sync last counted
 * them — the whole session, not the transcript up to the reading position
 * (the totals have only a present).
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
        hint: "The whole session at API prices — this conversation and every sub-agent it launched. Tokens are input, output and cache writes.",
      }}
    >
      {formatUsd(costUsd, "short")}
    </StatBadge>
  );
}
