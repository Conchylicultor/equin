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
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { useFetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { useToast } from "@plugins/shell/plugins/notifications/web";
import { useTask } from "@plugins/tasks/web";
import { taskMandates } from "@plugins/tasks/plugins/tasks-core/core";
import { mandateDefinitions } from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/core";
import { deleteTaskMandate, putTaskMandate } from "../../core";
import { MandateSource } from "./mandate-source";

/** The select's value for "no mandate of its own — follow the parent". */
const INHERIT = "inherit";

interface EffectiveMandate {
  mandateId: string;
  /**
   * The task stating it: this task itself, or the ancestor it inherits from.
   * Null only on a row written by a pre-`source_task_id` backend (the
   * migration's deferred-contract window; the next boot's reconcile and the
   * contract's backfill re-run fill it). Unknown, so it claims neither
   * "inherited" nor "set here": the select shows the mandate itself.
   */
  sourceTaskId: string | null;
}

/**
 * The task detail's Mandate value: the task's effective mandate as a select
 * over every named mandate. Picking one states it as the task's own (it then
 * governs the task's subtree); on a nested task, "Inherit from parent" drops
 * it again. An inherited mandate reads "<label> (inherited)" and names the
 * task it comes from.
 */
export function TaskMandateControl({ taskId }: { taskId: string }) {
  const row = useLive(taskMandates, { id: taskId });
  const mandate: ResourceResult<EffectiveMandate | null> = useMemo(
    () => mapRow(row, (r) => r ?? null),
    [row],
  );
  const task = useTask(taskId);
  const definitions = useLive(mandateDefinitions);
  const fetchEndpoint = useFetchEndpoint();
  const toast = useToast();

  if (
    mandate.status === "loading" ||
    definitions.status === "loading" ||
    task.status === "loading"
  ) {
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
  if (task.status === "error") {
    return (
      <ResourceErrorInline
        variant="inline"
        subject="the task"
        error={task.error}
        refetch={task.refetch}
      />
    );
  }

  const effective = mandate.data;
  // Only a task KNOWN to be nested is offered "Inherit"; a task not in the
  // tree yet (just filed) is not taken for a root.
  const isNested = task.data != null && task.data.folderId !== null;
  const inherited =
    effective !== null &&
    effective.sourceTaskId !== null &&
    effective.sourceTaskId !== taskId;
  const labelOf = (id: string) =>
    definitions.data.find((d) => d.id === id)?.label ?? id;
  const inheritLabel =
    inherited && effective
      ? `${labelOf(effective.mandateId)} (inherited)`
      : "Inherit from parent";
  const value =
    effective === null ? null : inherited ? INHERIT : effective.mandateId;

  const fail = (err: unknown) => {
    toast({
      type: "task",
      category: "other",
      title: "Failed to change the task's mandate",
      description: err instanceof Error ? err.message : String(err),
      variant: "error",
    });
  };
  const onChange = (next: string | null) => {
    if (!next || next === value) return;
    if (next === INHERIT) {
      fetchEndpoint(deleteTaskMandate, { taskId }).catch(fail);
      return;
    }
    fetchEndpoint(
      putTaskMandate,
      { taskId },
      { body: { mandateId: next } },
    ).catch(fail);
  };

  return (
    <Stack direction="row" align="center" gap="sm">
      <Select
        // base-ui resolves the collapsed trigger label from `items`.
        items={{
          // Always labelled, so an inherited value never shows its raw key.
          [INHERIT]: inheritLabel,
          ...Object.fromEntries(definitions.data.map((d) => [d.id, d.label])),
        }}
        value={value}
        onValueChange={onChange}
      >
        <SelectTrigger aria-label="Mandate">
          <SelectValue placeholder="None" />
        </SelectTrigger>
        <SelectContent>
          {(isNested || inherited) && (
            <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
          )}
          {definitions.data.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {inherited && effective.sourceTaskId !== null && (
        <MandateSource sourceTaskId={effective.sourceTaskId} />
      )}
    </Stack>
  );
}
