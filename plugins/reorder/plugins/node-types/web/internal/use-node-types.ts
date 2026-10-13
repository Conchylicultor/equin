import { useMemo } from "react";
import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import type { ReorderNodeType } from "@plugins/reorder/plugins/node-types/core";
import { ReorderNodes } from "../slots";

/**
 * Reads the `reorder.node-type` registry off the slot OBJECT, keyed by
 * `nodeType.type`. Mirrors `useFieldIdentities` — a raw `useRawContributions` read (rather
 * than `useContributions()`) so the node-type payload stays unsealed.
 */
export function useReorderNodeTypes(): Map<string, ReorderNodeType> {
  const raw = useRawContributions(ReorderNodes.NodeType);
  return useMemo(() => {
    const m = new Map<string, ReorderNodeType>();
    for (const c of raw) {
      const nodeType = (c as { nodeType?: ReorderNodeType }).nodeType;
      if (nodeType) m.set(nodeType.type, nodeType);
    }
    return m;
  }, [raw]);
}
