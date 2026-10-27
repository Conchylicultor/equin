import { useMemo } from "react";
import { useConfig } from "@plugins/config_v2/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { ReorderTree } from "@plugins/fields/plugins/reorder-tree/core";

/**
 * Read a reorderable slot's `items` tree from its config_v2 descriptor.
 *
 * The SINGLE definition of how reorder projects its config into a `ReorderTree`,
 * shared by the two consumers that must never disagree: the list middleware and
 * the data-level read hook (`useReorderedEntries`). `useConfig` on a
 * generically-typed descriptor returns a loose record; read the single `items`
 * field as a possibly-missing tree. One read per render site: the slot's
 * `config-v2.values` document plus the shared, param-less `config-v2.scopes` map
 * every config read observes (refcounted — one subscription per tab).
 */
export function useReorderTree(descriptor: ConfigDescriptor): ReorderTree {
  const cfg = useConfig(descriptor) as unknown as { items?: ReorderTree };
  return useMemo<ReorderTree>(() => cfg.items ?? [], [cfg.items]);
}
