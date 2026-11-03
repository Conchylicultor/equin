import { useMemo } from "react";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { taskMandates } from "@plugins/tasks/plugins/tasks-core/core";
import { mandateDefinitions } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/core";
import { putTaskMandate } from "../../core";

/**
 * The task detail's Mandate value: the task's effective mandate (its own, else
 * its nearest ancestor's) as a select over every named mandate. Picking one
 * states it as the task's own, so it governs the task's subtree.
 */
export function TaskMandateControl({ taskId }: { taskId: string }) {
  const row = useLive(taskMandates, { id: taskId });
  const mandate: ResourceResult<string | null> = useMemo(
    () => mapRow(row, (r) => (r ? r.mandateId : null)),
    [row],
  );
  const definitions = useLive(mandateDefinitions);
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();

  if (mandate.status === "loading" || definitions.status === "loading") {
    return <Loading variant="block" className="h-5 w-24" />;
  }
  if (mandate.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the mandate"
        error={mandate.error}
        refetch={mandate.refetch}
      />
    );
  }
  if (definitions.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the mandates"
        error={definitions.error}
        refetch={definitions.refetch}
      />
    );
  }

  const onChange = (mandateId: string | null) => {
    if (!mandateId || mandateId === mandate.data) return;
    fetchEndpoint(putTaskMandate, { taskId }, { body: { mandateId } }).catch(
      (err: unknown) => {
        toast({
          type: "task",
          category: "other",
          title: "Failed to change the task's mandate",
          description: err instanceof Error ? err.message : String(err),
          variant: "error",
        });
      },
    );
  };

  return (
    <Select
      // base-ui resolves the collapsed trigger label from `items`.
      items={Object.fromEntries(definitions.data.map((d) => [d.id, d.label]))}
      value={mandate.data}
      onValueChange={onChange}
    >
      <SelectTrigger aria-label="Mandate">
        <SelectValue placeholder="None" />
      </SelectTrigger>
      <SelectContent>
        {definitions.data.map((d) => (
          <SelectItem key={d.id} value={d.id}>
            {d.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
