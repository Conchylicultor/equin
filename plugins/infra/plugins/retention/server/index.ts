import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { defineRetention } from "./internal/define-retention";
export type { RetentionSpec, RetentionJob } from "./internal/define-retention";
export { markCascadeBounded } from "./internal/assert-cascade";
export { getTableGrowthBounds } from "./internal/growth-bounds";
export type { TableGrowthBound } from "./internal/growth-bounds";

export default {
  description:
    "Retention primitive, on every host: defineRetention wraps defineJob into a nightly TTL sweep (DELETE WHERE column < now()-ttl) whose growth bound is recorded only when the sweep is mounted; markCascadeBounded verifies at module eval that an FK onDelete cascade really reclaims the rows. getTableGrowthBounds exposes the resulting true set of table growth bounds.",
  portable: true,
} satisfies ServerPluginDefinition;
