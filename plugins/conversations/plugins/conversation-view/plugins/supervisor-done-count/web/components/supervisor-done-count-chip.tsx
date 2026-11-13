import { exposedColumns } from "@plugins/network/plugins/live/core";
import { mapRow, useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { ConversationItemConv } from "@plugins/conversations/plugins/conversation-ui/plugins/item/web";
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
 * The done-count chip of a supervisor's conversation: on the row of a
 * conversation whose task STATES the supervisor mandate (its root — a worker
 * below it inherits the mandate and gets no chip), how many tasks of the
 * supervisor's tree are done, however deep they were filed.
 *
 * The tree is every task whose effective mandate comes from this root (the
 * exposed `mandateSource`), read as ONE grouping by status — a few numbers,
 * never the tree's rows. The root itself is in that set; its own status is
 * taken back out.
 *
 * Renders nothing until both reads are known or for any other conversation;
 * an error glyph when one failed.
 */
export function SupervisorDoneCountChip({
  conv,
}: {
  conv: ConversationItemConv;
}) {
  const taskId = conv.taskId ?? null;
  const mandate = useLive(taskMandates, { id: taskId });
  const isRoot = useMemo(
    () =>
      mapRow(
        mandate,
        (r) =>
          r != null &&
          r.mandateId === supervisorMandate.id &&
          r.sourceTaskId === taskId,
      ),
    [mandate, taskId],
  );
  if (isRoot.status === "error")
    return (
      <ResourceErrorInline
        variant="icon"
        subject="the mandate"
        error={isRoot.error}
        refetch={isRoot.refetch}
      />
    );
  if (isRoot.status !== "ready" || !isRoot.data || taskId === null) return null;
  return <TreeDoneCount rootId={taskId} />;
}

// The mandate exposure's columns, so the read can filter by `sourceTaskId`.
const mandateColumns = exposedColumns(taskMandateShape.exposure);

/** The ring's radius in its 14-unit box, and its circumference. */
const R = 5;
const CIRCUMFERENCE = 2 * Math.PI * R;

function TreeDoneCount({ rootId }: { rootId: string }) {
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
  if (total === 0) return null;
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
            strokeDasharray={`${(done / total) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            className="stroke-success"
          />
        </svg>
      }
    >
      {done}
    </Badge>
  );
}
