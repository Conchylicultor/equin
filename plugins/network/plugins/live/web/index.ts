import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { useLive, useLiveRow } from "./internal/use-live";
export { mapRow } from "./internal/map-row";
export type {
  LivePageError,
  LivePagePlaceholder,
  LivePagesResult,
  LiveValuePagesOptions,
} from "./internal/use-pages";
export type { LivePagesQuery } from "./internal/page-source";
export { mintVisibleRange } from "./internal/visible-range";
export type { VisibleRange } from "./internal/visible-range";
export type { PagesTruncation } from "../shared/page-plan";
export type {
  LiveAllSelect,
  LiveIdsQuery,
  LiveListResult,
  LiveRowResult,
} from "./internal/use-live";

export default {
  description:
    "Unified live-resource API, read half: useLive (a collection's bounded window — where/orderBy/limit with canGrow/growing/loadMore — a grouping of a filterable column's values with counts, paged the same way, a collection declared `all` whole — every row in its declared order, or a select-scoped slice of it — or an explicit id set), useLiveRow (one row: loading, failed, found, or determinately absent), with mapRow reducing a row read to a ResourceResult of what the row means; useLive also reads a typed-query liveValue (its question encoded to one canonical tuple); a scroll collection's window — and a key-range-paged liveValue — is read as key-range pages — bounded windows tiling the order by server-minted row-key cuts, split when full and merged when small — given a measured viewport (useLive(c, q, { viewport })) with no depth limit, the pages near it live and the rest held stale up to a per-reader budget, past which they are height-keeping placeholders drawn before and after the rows, and without one every page live, capped at maxLimit rows.",
  contributions: [],
} satisfies PluginDefinition;
