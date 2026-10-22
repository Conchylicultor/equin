import {
  choiceLabel,
  resolveModel,
} from "@plugins/conversations/plugins/model-provider/core";
import { useModelCatalog } from "@plugins/conversations/plugins/model-provider/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";
import { useTaskAutoStart } from "../hooks";
import { setAutoStart } from "@plugins/tasks/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { symbol } from "@plugins/ui/plugins/icons/core";

const scheduleIcon = symbol("schedule");

export function QueuedChipAction({ row }: ItemActionProps<TaskListItem>) {
  const taskId = row.id;
  const autoStart = useTaskAutoStart(taskId);
  const catalog = useModelCatalog();
  const fetchEndpoint = useFetchEndpoint();
  // Nothing while loading, nor for an unarmed task (no marker row): the chip
  // appears once the task is known to be armed. A failed read is a small error
  // icon whose click retries — never silently "not armed".
  if (autoStart.status === "loading") return null;
  if (autoStart.status === "error") {
    return (
      <ResourceErrorInline
        variant="icon"
        icon={scheduleIcon}
        subject="the auto-start state"
        error={autoStart.error}
        refetch={autoStart.refetch}
      />
    );
  }
  if (!autoStart.found) return null;
  const queuedModel = autoStart.row.autoStartModel;

  const label = choiceLabel(queuedModel);
  // A pinned version the catalog has retired (or never knew) will not launch:
  // the queue refuses it rather than substitute another model. Say so here,
  // where the task shows it is queued. Until the (preloaded) catalog settles,
  // the plain queued chip — nothing is claimed about the model yet.
  const resolution =
    catalog.status === "ready"
      ? resolveModel(queuedModel, catalog.data)
      : undefined;
  if (resolution && !resolution.ok) {
    return (
      <Badge
        as="button"
        variant="destructive"
        // eslint-disable-next-line spacing/no-adhoc-spacing, layout/no-adhoc-layout -- same one-off offset and rigidity as the queued chip below
        className="ml-1 shrink-0"
        tooltip={`${label} is ${resolution.reason === "retired" ? "retired" : "not a model this machine knows"} — this task will not auto-start. Pick another model on the task, or click to cancel.`}
        aria-label={`Cancel auto-start (${label}, ${resolution.reason})`}
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void setAutoStart(fetchEndpoint, taskId, "none");
        }}
      >
        {label} {resolution.reason}
      </Badge>
    );
  }
  return (
    <Badge
      as="button"
      variant="warning"
      // eslint-disable-next-line spacing/no-adhoc-spacing, layout/no-adhoc-layout -- ml-1 one-off inline offset of the chip from its preceding label (no parent gap to lift into); shrink-0 keeps this rigid action chip whole inside the data-view item-actions flex cluster (owned by Row, not this file)
      className="ml-1 shrink-0 hover:bg-warning/20"
      tooltip="Auto-start when parent is done — click to cancel"
      aria-label={`Cancel auto-start (${label})`}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        void setAutoStart(fetchEndpoint, taskId, "none");
      }}
    >
      Queued · {label}
    </Badge>
  );
}
