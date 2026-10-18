import { useMemo } from "react";
import {
  FieldPresentation,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { eventSourcesEntityRef } from "@plugins/apps/plugins/events/plugins/events-core/core";
import { useEventSourceType, useEventSourceTypes } from "./source-types";

/**
 * The type dimension's options, built from the live registry of source types,
 * never a literal list: a third source type must widen the filter with zero
 * edits here. A registry read is always known (a contribution slot).
 */
function useSourceTypeOptions(): LiveFieldOptionsRead {
  const types = useEventSourceTypes();
  return useMemo(
    () => types.map((t): LiveFieldOption => ({ value: t.id, label: t.label })),
    [types],
  );
}

/**
 * The one per-field cell on the sources list, and it exists for exactly one
 * state the option list cannot hold: a source whose TYPE PLUGIN is not
 * installed has no option to look up, so the generic chip would print the bare
 * id (`shotgun`) and the row would read like every other one. Naming it out
 * loud is the same "not installed" state the Settings section shows — and it
 * still names no type: the id comes from the row.
 */
function SourceTypeCell({ type }: { type: string }) {
  const lookup = useEventSourceType(type);
  return (
    <Badge
      variant="muted"
      tooltip={
        lookup.status === "registered"
          ? undefined
          : "This source's type plugin is not installed, so it cannot be refreshed or configured."
      }
    >
      {lookup.status === "registered"
        ? lookup.type.label
        : `${type} (not installed)`}
    </Badge>
  );
}

/**
 * How a source's stored fields present in every list of sources: the type from
 * the registry (options and the not-installed cell), the status and the enabled
 * switch left out of the body by default (`state` is derived from them; each
 * stays a filter / sort / group-by dimension), and the last run right-aligned.
 */
export const sourcePresentation = FieldPresentation.Register({
  owner: eventSourcesEntityRef,
  fields: {
    type: {
      useOptions: useSourceTypeOptions,
      cell: (type) => <SourceTypeCell type={type} />,
    },
    status: { visible: false },
    enabled: { visible: false },
    lastRunAt: { align: "end" },
  },
});
