import { useMemo } from "react";
import { formatTokenCount } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import {
  StatBadge,
  useTranscriptRead,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/transcript-stats/web";
import { readBudget } from "../budget";

// The reading is the total charged, so it only ever climbs — and scrolling back
// through history walks it down to what it was at the row on screen. There is
// no threshold to get loud about: the allowance it is charged against is padded
// far beyond what a session spends, so a share of it means nothing and the stat
// stays a plain grey reading rather than inventing an alarm.
export function TokenBudgetStat() {
  const { events } = useTranscriptRead();
  const status = useMemo(() => readBudget(events), [events]);
  // The harness has not reported an allowance in this stretch of the transcript.
  if (!status) return null;

  const { spent, spentThisRequest, requests, allowance } = status;

  const title = [
    `${spent.toLocaleString()} tokens charged to the agent's work allowance`,
    `${spentThisRequest.toLocaleString()} of ${allowance.toLocaleString()} in the current request`,
    `Across ${requests} request${requests === 1 ? "" : "s"} — the allowance re-anchors in full on each new one, so what is "left" is never a conversation total.`,
  ].join("\n");

  return <StatBadge tooltip={title}>{formatTokenCount(spent)} used</StatBadge>;
}
