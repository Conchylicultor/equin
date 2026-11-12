import type { MirrorRefusal } from "@plugins/database/plugins/table-mirror/core";
import { MirrorSet, type MirrorSetDefinition } from "./define";

/**
 * The contributed set with this id, or the `unknown-set` refusal a route
 * answers — the source registry is the allowlist of what may be read.
 */
export function resolveMirrorSet(
  setId: string,
): MirrorSetDefinition | MirrorRefusal {
  return (
    MirrorSet.getContributions().find((s) => s.id === setId) ?? {
      kind: "unknown-set",
      setId,
    }
  );
}
