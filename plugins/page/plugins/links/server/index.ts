import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { DerivedTable } from "@plugins/database/plugins/derived-tables/server";
import { eventField, Trigger } from "@plugins/infra/plugins/events/server";
import {
  blocksChanged,
  BlockLifecycle,
} from "@plugins/page/plugins/editor/server";
import { reindexLinksJob } from "./internal/reindex-job";
import { pageLinksBackfillWarmup } from "./internal/backfill";
import {
  pageBacklinkEdgesServed,
  pageBacklinksServed,
  pageLinkTargetsServed,
} from "./internal/resources";
import { pageLinkTargetsJoin } from "./internal/link-target-rows";
import { backlinksDeleteHook } from "./internal/delete-hook";

export { PageLinks } from "./internal/extractor";
export type { PageLinkExtractor } from "./internal/extractor";
export { reindexPage } from "./internal/reindex";
export { loadBacklinkSources } from "./internal/backlink-sources";
export type { BacklinkSource } from "./internal/backlink-sources";

export default {
  description:
    "Backlinks index for cross-page links: page_links edge table, extractor registry, reindex, backlinks resource, and the boot backfill (a warm-up reindexing every live page's outgoing links, off the serving-critical boot path, once per change of the derivation code: derive-edges.ts plus every extractor's module).",
  // The steady-state reindex trigger's job, and the boot backfill's warm-up.
  register: [reindexLinksJob, pageLinksBackfillWarmup],
  contributions: [
    ...pageBacklinkEdgesServed.declare,
    ...pageBacklinksServed.declare,
    ...pageLinkTargetsServed.declare,
    // Each page's outgoing link targets, materialized (`page_link_targets`).
    DerivedTable(pageLinkTargetsJoin.rollup),
    // Reindex a page's outgoing links whenever its blocks change. Declared (not
    // imperatively bound) so the events plugin's syncTriggerContributions makes
    // it idempotent across reboots. Match-any on pageId — the per-emit pageId
    // reaches the job via the event payload.
    Trigger({
      on: blocksChanged,
      do: reindexLinksJob,
      with: { pageId: eventField("pageId") },
      oneShot: false,
    }),
    // Re-push the backlinks panels of pages a deleted subtree linked to: the FK
    // cascade wipes those page_links edges without going through the reindexer.
    // A trash or restore writes no edge: readers filter liveness
    // (`./internal/delete-hook.ts`).
    BlockLifecycle.OnDelete(backlinksDeleteHook),
  ],
} satisfies ServerPluginDefinition;
