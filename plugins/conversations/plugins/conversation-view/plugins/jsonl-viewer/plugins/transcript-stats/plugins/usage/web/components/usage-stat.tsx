import { formatTokenCount } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  StatBadge,
  useTranscriptFold,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { matchResource } from "@plugins/primitives/plugins/live-state/web";
import { usageFold, usageTotals } from "../../core";

export function UsageStat() {
  const usage = useTranscriptFold(usageFold);
  // A reading in the strip: nothing until it is known.
  return matchResource(usage, {
    loading: () => null,
    error: () => null,
    ready: (state) => {
      const totals = usageTotals(state);
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
    },
  });
}
