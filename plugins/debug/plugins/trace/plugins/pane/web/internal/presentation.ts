import { useMemo } from "react";
import {
  FieldPresentation,
  useLive,
  type LiveFieldOption,
  type LiveFieldOptionsRead,
} from "@plugins/network/plugins/live/web";
import { mapResource } from "@plugins/primitives/plugins/live-state/web";
import { traceEvents } from "@plugins/debug/plugins/trace/plugins/engine/core";

// A trigger kind's group, alphabetical. The column is not null, so a null
// group cannot occur — it would carry no option to name.
function toOptions(
  groups: readonly { value: string | null }[],
): readonly LiveFieldOption[] {
  return groups
    .flatMap((g) => (g.value === null ? [] : [g.value]))
    .sort()
    .map((kind) => ({ value: kind, label: kind }));
}

/**
 * The `triggerKind` field's options: every kind the trace store holds — an OPEN
 * vocabulary (any plugin may mint a trigger kind), so read as a grouping of the
 * whole store rather than listed. Loading until the grouping lands.
 */
export function useTriggerKindOptions(): LiveFieldOptionsRead {
  const groups = useLive(traceEvents, { groupBy: "triggerKind" });
  return useMemo(() => mapResource(groups, toOptions), [groups]);
}

/** The Trigger column of the Slow Events list: an enum over the kinds the store holds. */
export const triggerKindPresentation = FieldPresentation.Register({
  owner: traceEvents,
  fields: { triggerKind: { useOptions: useTriggerKindOptions } },
});
