import { exposedColumns } from "@plugins/network/plugins/live/core";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  mapResource,
  ResourceErrorInline,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  mandateDefinitions,
  mandateIsKindOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/plugins/definitions/core";
import {
  taskMandates,
  taskMandateShape,
  taskWindow,
} from "@plugins/tasks/plugins/tasks-core/core";
import { supervisorMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import { useTask } from "@plugins/tasks/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { useMemo } from "react";

/**
 * Whether `taskId` is a supervisor's root — its task STATES a mandate that is
 * a kind of supervisor (the plain one, a role session's, any mandate built on
 * it), read from the mandate definitions' lineage; a worker below it inherits
 * the mandate and is not one. Loading until the mandate is known; read live,
 * so a mandate changed mid-conversation moves it.
 */
export function useIsSupervisorRoot(
  taskId: string | null | undefined,
): ResourceResult<boolean> {
  const id = taskId ?? null;
  const mandate = useLive(taskMandates, { id });
  const definitions = useLive(mandateDefinitions);
  return useMemo(
    () =>
      mapResource(
        combineResources({
          stated: mapRow(mandate, (r) =>
            id !== null && r != null && r.sourceTaskId === id
              ? r.mandateId
              : null,
          ),
          definitions,
        }),
        ({ stated, definitions: defs }) =>
          stated !== null && mandateIsKindOf(defs, stated, supervisorMandate),
      ),
    [mandate, definitions, id],
  );
}

// The mandate exposure's columns, so the read can filter by `sourceTaskId`.
const mandateColumns = exposedColumns(taskMandateShape.exposure);

/** The ring's radius in its 14-unit box, and its circumference. */
const R = 5;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * A supervisor's done count: how many tasks of its tree are done, however deep
 * they were filed, with a ring filled by the done share of the whole tree
 * (empty for a supervisor that has filed nothing yet). Hover for done / open /
 * dropped.
 *
 * The tree is every task whose effective mandate comes from this root (the
 * exposed `mandateSource`), read as ONE grouping by status — a few numbers,
 * never the tree's rows. The root itself is in that set; its own status is
 * taken back out.
 */
export function SupervisorDoneCount({ rootId }: { rootId: string }) {
  const groups = useLive(taskWindow, {
    columns: [mandateColumns],
    groupBy: "status",
    where: { "tasks_ext_mandate.sourceTaskId": rootId },
  });
  // The root is in its own tree (its mandate's source is itself); its status
  // is taken back out of its group.
  const root = useTask(rootId);
  if (groups.status === "loading" || root.status === "loading") return null;
  if (root.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the supervisor's task"
        error={root.error}
        refetch={root.refetch}
      />
    );
  if (groups.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the supervisor's done count"
        error={groups.error}
        refetch={groups.refetch}
      />
    );
  const rootStatus = root.data?.status;
  const countOf = (status: string) =>
    (groups.data.find((g) => g.value === status)?.count ?? 0) -
    (status === rootStatus ? 1 : 0);
  const total =
    groups.data.reduce((n, g) => n + g.count, 0) - (root.data ? 1 : 0);
  const done = countOf("done");
  const dropped = countOf("dropped");
  const open = total - done - dropped;
  const tooltip = [
    `${done} done`,
    open > 0 && `${open} open`,
    dropped > 0 && `${dropped} dropped`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Badge
      shape="pill"
      tooltip={tooltip}
      icon={
        <svg viewBox="0 0 14 14" aria-hidden className="size-3 -rotate-90">
          <circle
            cx="7"
            cy="7"
            r={R}
            fill="none"
            strokeWidth="2.2"
            className="stroke-muted-foreground/30"
          />
          <circle
            cx="7"
            cy="7"
            r={R}
            fill="none"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeDasharray={`${total === 0 ? 0 : (done / total) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            className="stroke-success"
          />
        </svg>
      }
    >
      {done}
    </Badge>
  );
}
