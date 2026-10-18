import { useRawContributions } from "@plugins/framework/plugins/web-sdk/core";
import { ReorderSlots } from "../slots";
import type { ReorderAreaEditor } from "./editor-contract";

/**
 * The contributed layout editor, or `null` where none ships. More than one is a
 * wiring error (two drag hosts would bind the same items), so it throws.
 */
export function useReorderAreaEditor(): ReorderAreaEditor | null {
  const raw = useRawContributions(ReorderSlots.AreaEditor);
  if (raw.length > 1)
    throw new Error(
      `reorder: ${raw.length} ReorderSlots.AreaEditor contributions — exactly one plugin may edit slot layouts`,
    );
  return (raw[0] as { editor: ReorderAreaEditor } | undefined)?.editor ?? null;
}
