import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  computedLoads,
  type ComputedLoads,
} from "@plugins/packages/plugins/source-digest/plugins/computed-loads/core";

// How many loads by a computed path one module makes, read the digest's own
// way (`computedLoads`), as the per-file scan boot:closure-digestable keeps as
// file records: a module's count is a function of its bytes and path, so a
// pass after an edit reads only the edited modules of the backend's closure,
// never all ~5.9k.

export const COMPUTED_LOADS_SCAN: FileScan<ComputedLoads> = {
  url: import.meta.url,
  scan: (src, rel) => computedLoads(rel, src),
};
