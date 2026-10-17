import { useMemo } from "react";
import { formatTokenCount } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  StatBadge,
  useTranscriptRead,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { aggregateUsage } from "../usage";

export function UsageStat() {
  const { events } = useTranscriptRead();
  const totals = useMemo(() => aggregateUsage(events), [events]);
  // Nothing has reported usage yet in the stretch being read.
  if (!totals) return null;

  return (
    <StatBadge
      tooltip={`Latest context: ${totals.latestContext.toLocaleString()} tokens\nTotal output: ${totals.output.toLocaleString()} tokens`}
    >
      {formatTokenCount(totals.latestContext)} ctx ·{" "}
      {formatTokenCount(totals.output)} out
    </StatBadge>
  );
}
