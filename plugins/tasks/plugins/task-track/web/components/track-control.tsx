import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { TRACK_META, type TaskTrack } from "../../core";
import { useTaskTrack } from "../hooks";
import { setTaskTrackRemote } from "../internal/api";

const OTHER_TRACK: Record<TaskTrack, TaskTrack> = {
  main: "sidequest",
  sidequest: "main",
};

/**
 * The task detail's Track value: the track badge as a button. Clicking it
 * moves the task to the other track (the human override of what the filing
 * agent chose). Only the track changes — the dependency edges and the
 * auto-start marker stay as they are.
 */
export function TaskTrackControl({ taskId }: { taskId: string }) {
  const result = useTaskTrack(taskId);
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();
  if (result.status === "loading") {
    return <Loading variant="block" className="h-5 w-16" />;
  }
  if (result.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the track"
        error={result.error}
        refetch={result.refetch}
      />
    );
  }
  const meta = TRACK_META[result.data];
  const next = OTHER_TRACK[result.data];
  const onClick = () => {
    setTaskTrackRemote(fetchEndpoint, taskId, next).catch((err: unknown) => {
      toast({
        type: "task",
        title: "Failed to change the task's track",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      });
    });
  };
  return (
    <Badge
      as="button"
      type="button"
      variant={meta.variant}
      tooltip={`${meta.hint} Click to move it to ${TRACK_META[next].label}.`}
      aria-label={`Track: ${meta.label}. Move to ${TRACK_META[next].label}`}
      onClick={onClick}
    >
      {meta.label}
    </Badge>
  );
}
