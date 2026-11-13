import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { ExcludeFromChangeFeed } from "@plugins/network/plugins/live/plugins/change-feed/server";
import { collectEndpoint } from "../core";
import { analyticsMirrorContributions } from "./internal/mirror";

export { analyticsMirrorTables } from "./internal/mirror";
import { analyticsRollupJob } from "./internal/rollup";
import { analyticsVisitsRetention } from "./internal/retention";
import { handleCollect } from "./internal/routes";
import {
  analyticsConsentKeys,
  analyticsHits,
  analyticsVisitMembers,
  analyticsVisitorLinks,
  analyticsVisits,
} from "./internal/tables";

// A demo's seed writes its analytics through the real collect path.
export { recordCollect } from "./internal/collect";
export type {
  AnalyticsReadDb,
  CollectContext,
  CountryLookup,
} from "./internal/collect";
// The report and the visit list's reads, run where the tables are: the
// deploy app runs them on this computer's copy of a site's tables
// (site-mirror) — collect's own SQL, wherever the tables are.
export { runAnalyticsQuery } from "./internal/report";
export {
  countVisits,
  readVisitGroups,
  readVisitsById,
  readVisitWindow,
} from "./internal/sessions";
export type {
  VisitFilterable,
  VisitReads,
  VisitWindowQuery,
} from "./internal/sessions";

export default {
  description:
    "Owns the analytics tables (daily salts kept 30 days with the hash → visitor links that let a returning visitor keep one id, 90-day visits and hits, forever daily totals at every single-filter level and forever per-visit memberships for exact unique visitors over any range), the public collect endpoint, the analytics mirror set, the report (runAnalyticsQuery) and the visit-list reads (a window of individual visits with their hits, filtered in the filter language) — both run by the deploy app on its local copy of the tables — the nightly analytics.rollup job and the visits retention sweep that refuses to delete a day not yet rolled up.",
  httpRoutes: {
    [collectEndpoint.route]: rawEndpointHandler(collectEndpoint, handleCollect),
  },
  contributions: [
    // The analytics mirror set (the deploy app's site-mirror copies it); the
    // salts and visitor links never leave the box.
    ...analyticsMirrorContributions,
    // Every public page load writes here; nothing renders these rows live
    // (the deploy app's dashboard reads its own copy, pushed by the mirror's
    // applied pages), so a change-feed trigger would be pure notify churn
    // driven by internet traffic.
    ExcludeFromChangeFeed({
      table: analyticsVisits,
      reason:
        "Written on every public pageview; no live-state resource reads it — the deploy app's report reads its own copy of it.",
    }),
    ExcludeFromChangeFeed({
      table: analyticsHits,
      reason:
        "Written on every public pageview and event; no live-state resource reads it — the deploy app's report reads its own copy of it.",
    }),
    ExcludeFromChangeFeed({
      table: analyticsVisitorLinks,
      reason:
        "Written on a visitor's first public hit of each day; no live-state resource reads it — it only resolves visitor ids at collect time.",
    }),
    ExcludeFromChangeFeed({
      table: analyticsConsentKeys,
      reason:
        "Written on a consenting visitor's first public hit of each day; no live-state resource reads it — it only resolves visitor ids at collect time.",
    }),
    ExcludeFromChangeFeed({
      table: analyticsVisitMembers,
      reason:
        "Written in bulk by the nightly rollup; no live-state resource reads it — the deploy app's report reads its own copy of it.",
    }),
  ],
  register: [analyticsRollupJob, analyticsVisitsRetention],
} satisfies ServerPluginDefinition;
