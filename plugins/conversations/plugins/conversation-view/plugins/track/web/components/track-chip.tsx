import { rowOrStale } from "@plugins/network/plugins/live/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { useConversationById } from "@plugins/conversations/web";
import { HeaderChip } from "@plugins/conversations/plugins/conversation-view/plugins/header/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { TRACK_META } from "@plugins/tasks/plugins/task-track/core";
import { useTaskTrack } from "@plugins/tasks/plugins/task-track/web";

/**
 * The conversation's task track as a header chip ("Main" / "Sidequest"),
 * muted like the model chip beside it — context, not a status.
 */
export function TrackChip() {
  const { convId } = conversationPane.useParams();
  const conversation = rowOrStale(useConversationById(convId));
  if (!conversation) return null;
  return <TaskTrackChip taskId={conversation.taskId} />;
}

function TaskTrackChip({ taskId }: { taskId: string }) {
  const result = useTaskTrack(taskId);
  // Not known yet: the loading block, never a "Main" that might flip.
  if (result.status === "loading") {
    return <Loading variant="block" className="h-5 w-16" />;
  }
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the track"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  return (
    <HeaderChip colorClass="bg-chip text-subtle-foreground border-border">
      {TRACK_META[result.data].label}
    </HeaderChip>
  );
}
