import { useMemo } from "react";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { reorderDescriptors } from "./descriptors";
import { useReorderTree } from "./use-reorder-config";
import { applyTree, type ReorderState } from "./sorting";

/**
 * The data-level counterpart to the reorder list middleware: reads a reorderable
 * slot's config tree and applies it over `contributions`, returning the same
 * `ReorderState` (ordered top-level `entries` + `hidden`) the middleware renders
 * — but with NO rendering and NO node-type registry involvement. Data consumers
 * (e.g. block menus that draw their own rows) branch on `entry` shape via
 * `isNodeData`, read a header's label off `payload.label`, and get hidden
 * contributions routed to `state.hidden` (respected — never surfaced) for free.
 *
 * It shares `useReorderTree` (config read) and `applyTree` with the middleware,
 * so the two consumers of a slot's layout can never disagree.
 *
 * A read: `loading` until the slot's layout is known — never the contributions
 * in raw order standing in for it (hidden ones would show, then vanish). On
 * error, `stale` is the last-known layout applied when there was one.
 *
 * Throws for a non-reorderable slot id (fail loud). The lookup happens BEFORE any
 * hook call, so the throw never violates the rules of hooks.
 */
export function useReorderedEntries(
  slotId: string,
  contributions: readonly Contribution[],
): ResourceResult<ReorderState> {
  const descriptor = reorderDescriptors.get(slotId);
  if (!descriptor) {
    throw new Error(
      `useReorderedEntries: "${slotId}" is not a reorderable slot`,
    );
  }
  const tree = useReorderTree(descriptor);
  return useMemo(
    () => mapResource(tree, (t) => applyTree(contributions, t)),
    [contributions, tree],
  );
}
