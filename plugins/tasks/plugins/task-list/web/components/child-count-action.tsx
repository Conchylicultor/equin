import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import type { TaskTreeRow } from "@plugins/tasks/plugins/tasks-core/core";

/** How many tasks are filed under this one — the row's own `$childCount`. */
export function ChildCountAction({ row }: ItemActionProps<TaskTreeRow>) {
  if (row.$childCount === 0) return null;

  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- rigid count leaf inside the data-view item-actions flex cluster (owned by Row); must never shrink
    <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
      {row.$childCount}
    </span>
  );
}
