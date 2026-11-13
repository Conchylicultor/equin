import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { SegmentedProgressBar } from "@plugins/ui/plugins/segmented-progress-bar/web";
import type { ConversationItemConv } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
import {
  SupervisorDoneCount,
  useIsSupervisorRoot,
} from "@plugins/conversations/plugins/conversation-view/plugins/supervisor-done-count/web";
import { PHASE_STEPS, PROGRESS_SUMMARY } from "../../core";
import { useProgressFor } from "../internal/use-progress";

/**
 * A conversation row's progress: its 4-step bar — or, on a supervisor's
 * conversation (its task states the supervisor mandate), the supervisor's done
 * count instead, since a supervisor's progress is its tree's.
 */
export function ProgressBarRow({ conv }: { conv: ConversationItemConv }) {
  const result = useProgressFor(conv.id);
  const supervisor = useIsSupervisorRoot(conv.taskId);
  if (conv.kind === "agent") return null;
  if (supervisor.status === "loading") return null;
  if (supervisor.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the mandate"
        error={supervisor.error}
        refetch={supervisor.refetch}
      />
    );
  if (supervisor.data && conv.taskId)
    return <SupervisorDoneCount rootId={conv.taskId} />;
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
