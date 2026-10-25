import { useMemo } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import type { SlotHandle } from "@plugins/framework/plugins/slot-declaration/core";
import { isNodeData, type TopLevelEntry } from "./sorting";
import { useReorderedEntries } from "./use-reordered-entries";

/** The contributions of `entries`, in order — a container's members in its place. */
function contributionsOf(entries: readonly TopLevelEntry[]): Contribution[] {
  const out: Contribution[] = [];
  for (const entry of entries) {
    if (!isNodeData(entry)) out.push(entry);
    else if (entry.members) out.push(...contributionsOf(entry.members));
  }
  return out;
}

/**
 * The layout order slot-render's `useSlotOrder` reads (`SlotRender.Order`,
 * contributed by `reorder/slot-middleware`): the slot's config tree applied
 * over its contributions — the same `useReorderedEntries` the list middleware's
 * tree comes from — with hidden contributions dropped, layout nodes (spacers,
 * dividers) dropped, and a header's members in its place. Throws for a slot
 * that is not reorderable.
 */
export function useLayoutOrder(
  slot: SlotHandle,
  contributions: readonly Contribution[],
): readonly Contribution[] {
  const { entries } = useReorderedEntries(slot.id, contributions);
  return useMemo(() => contributionsOf(entries), [entries]);
}
