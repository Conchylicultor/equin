import { useMemo } from "react";
import { useConfigResult } from "@plugins/config_v2/web";
import type { ConfigDescriptor } from "@plugins/config_v2/core";
import type { ReorderTree } from "@plugins/fields/plugins/reorder-tree/core";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";

/**
 * Read a reorderable slot's `items` tree from its config_v2 descriptor, as a
 * read: `loading` until the slot's config document is known.
 *
 * The SINGLE definition of how reorder projects its config into a `ReorderTree`,
 * shared by the two consumers that must never disagree: the list middleware and
 * the data-level read hook (`useReorderedEntries`). It reads `useConfigResult`,
 * never `useConfig`: the latter answers a not-yet-loaded document with the
 * descriptor's defaults (`items: []`), which is indistinguishable from "no
 * layout" — every slot would render in raw registration order, hidden items
 * included, then jump. A known document without an `items` tree is a real empty
 * layout (`[]`). One read per render site: the slot's `config-v2.values`
 * document plus the shared, param-less `config-v2.scopes` map every config read
 * observes (refcounted — one subscription per tab).
 *
 * `useConfigResult` on a generically-typed descriptor returns a loose record;
 * read the single `items` field as a possibly-missing tree.
 */
export function useReorderTree(
  descriptor: ConfigDescriptor,
): ResourceResult<ReorderTree> {
  const doc = useConfigResult(descriptor) as unknown as ResourceResult<{
    items?: ReorderTree;
  }>;
  return useMemo(() => mapResource(doc, (d) => d.items ?? []), [doc]);
}
