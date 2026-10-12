import { useMemo } from "react";
import type {
  FieldDef,
  FieldExtensionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import type { TaskListItem } from "@plugins/tasks/plugins/tasks-core/core";
import {
  automationOrigins,
  automationsCatalog,
  type AutomationOriginRow,
} from "../../core";

// Stable (module-level), so the `select` re-runs only when the set changes.
function toOriginMap(
  rows: readonly AutomationOriginRow[],
): ReadonlyMap<string, string> {
  return new Map(rows.map((r) => [r.taskId, r.automationId]));
}

// The value of a task no automation filed: a person (or an agent acting for
// one) did.
const BY_HAND = "by-hand";

/**
 * Field extension contributed into the task list's `Tasks.Fields`: one
 * `origin` enum field — which automation filed the task, or "By hand" — whose
 * cell is a badge on automated tasks only, and which the tasks DataView can
 * group and filter by.
 *
 * While the filings or the automations are not known yet the value is `null`
 * and the cell the loading block — never "By hand", which would be a claim
 * about the task that then reverses.
 */
export function OriginField({ render }: FieldExtensionProps<TaskListItem>) {
  // Every task's automation, from the whole origin set, so the list can name
  // an origin for EVERY task row.
  const filings = useLive(automationOrigins, { select: toOriginMap });
  const catalog = useLive(automationsCatalog);
  const result = useMemo(
    () => combineResources({ filings, catalog }),
    [filings, catalog],
  );
  const fields = useMemo<FieldDef<TaskListItem>[]>(() => {
    // A failed read keeps nothing to show: the cell stays the loading block
    // rather than claiming "By hand".
    const known = foldResource(result, {
      loading: () => null,
      error: () => null,
      ready: (d) => d,
    });
    const originOf = known ? known.filings : null;
    const labelOf = new Map((known?.catalog ?? []).map((a) => [a.id, a.label]));
    const valueOf = (t: TaskListItem) =>
      originOf === null ? null : (originOf.get(t.id) ?? BY_HAND);
    return [
      {
        id: "origin",
        label: "Automation",
        type: "enum",
        align: "end",
        options: [
          ...(known?.catalog ?? []).map((a) => ({
            value: a.id,
            label: a.label,
            variant: "info" as const,
          })),
          { value: BY_HAND, label: "By hand" },
        ],
        value: valueOf,
        cell: (t) => {
          const origin = valueOf(t);
          if (origin === null) {
            return <Loading variant="block" className="h-4 w-12" />;
          }
          if (origin === BY_HAND) return null;
          return (
            <Badge variant="info" title="Filed by an automation">
              {labelOf.get(origin) ?? origin}
            </Badge>
          );
        },
        // A grouping/filter dimension, not searchable text: kept out of the
        // full-text search accessor, still in the Filter pill.
        filterable: false,
      },
    ];
  }, [result]);
  return <>{render(fields)}</>;
}
