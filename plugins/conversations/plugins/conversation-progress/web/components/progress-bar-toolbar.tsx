import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { SegmentedProgressBar } from "@plugins/ui/plugins/segmented-progress-bar/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { PHASE_STEPS, PROGRESS_SUMMARY } from "../../core";
import { useProgressFor } from "../internal/use-progress";

export function ProgressBarToolbar() {
  const { convId } = conversationPane.useParams();
  const conversation = useConversationById(convId);
  const result = useProgressFor(convId);
  if (!conversation) return null;
  if (conversation.kind === "agent") return null;
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
    <Inline gap="none">
      <SegmentedProgressBar
        steps={PHASE_STEPS}
        activeStep={progress.phase}
        summary={PROGRESS_SUMMARY}
      />
    </Inline>
  );
}
