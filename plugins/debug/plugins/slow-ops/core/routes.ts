import { defineRoute } from "@plugins/primitives/plugins/pane/core";
import { traceListRoute } from "@plugins/debug/plugins/trace/plugins/engine/core";

// One slow op's detail (/debug/traces/op/:id), under the Slow Events pane the
// Aggregates tab lives in. In core so a report's KindView can deep-link it.
// `op/:id` — a static prefix, per the pane segment rule (the sibling trace
// detail is `x/:id`).
export const slowOpDetailRoute = defineRoute({
  id: "slow-op-detail",
  segment: "op/:id",
  parent: traceListRoute,
});
