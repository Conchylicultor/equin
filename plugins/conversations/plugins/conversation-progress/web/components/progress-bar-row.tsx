import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { SegmentedProgressBar } from "@plugins/ui/plugins/segmented-progress-bar/web";
import type { ConversationItemConv } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import { PHASE_STEPS, PROGRESS_SUMMARY } from "../../core";
import { useProgressFor } from "../internal/use-progress";

export function ProgressBarRow({ conv }: { conv: ConversationItemConv }) {
  const result = useProgressFor(conv.id);
  if (conv.kind === "agent") return null;
  // Nothing while loading, nothing when no progress is classified yet.
  if (result.status === "loading") return null;
  if (result.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the progress"
        error={result.error}
        refetch={result.refetch}
      />
    );
  if (!result.found) return null;
  const progress = result.row;
  return (
    <SegmentedProgressBar
      steps={PHASE_STEPS}
      activeStep={progress.phase}
      summary={PROGRESS_SUMMARY}
      compact
    />
  );
}
