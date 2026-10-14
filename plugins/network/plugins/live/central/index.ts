import type { CentralPluginDefinition } from "@plugins/framework/plugins/central-core/core";

export { serveValue } from "./internal/serve-value";
export { sliceRange } from "../core/internal/key-order";
export type {
  CentralServedPagedValue,
  CentralServedQueryValue,
  CentralServedValue,
} from "./internal/serve-value";

export default {
  description:
    'Unified live-resource API, central half: serveValue for a liveValue declared `origin: "central"` — the external arm only (central has no change feed), registered through the central plugin\'s `resources: [served]`; its options compile through the same code as the worktree serveValue.',
} satisfies CentralPluginDefinition;
