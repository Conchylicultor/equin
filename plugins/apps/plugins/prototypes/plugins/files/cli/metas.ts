import type { Mount } from "@plugins/infra/plugins/paths/plugins/data-files/core";
import type { PrototypeMeta } from "../core";
import { listPrototypeMetas } from "../shared/list-metas";

/**
 * Every prototype folder under `tree` read as the gallery reads it — for a
 * verb that works on a prototypes tree other than the data dir (a demo's seed
 * laid out in a temp dir, say), which no server barrel can be pointed at.
 */
export function prototypeMetasIn(tree: Mount): Promise<PrototypeMeta[]> {
  return listPrototypeMetas(tree);
}
