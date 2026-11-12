import {
  defineMirrorSet,
  MirrorSet,
  NeverMirrored,
} from "@plugins/database/plugins/table-mirror/plugins/source/server";
import {
  analyticsDaily,
  analyticsHits,
  analyticsSalts,
  analyticsVisitMembers,
  analyticsVisitorLinks,
  analyticsVisits,
} from "./tables";
import { ANALYTICS_MIRROR_SET_ID } from "../../core";

/**
 * The `analytics` mirror set: what the deploy app copies from a deployed
 * site's box into this computer (`apps/deploy/site-mirror`) so its reports
 * run locally on the same SQL. The raw visits and hits (90 days; a deleted
 * visit's hits arrive as their own tombstones) and the forever rollups.
 */
export const analyticsMirror = defineMirrorSet({
  id: ANALYTICS_MIRROR_SET_ID,
  tables: [
    analyticsVisits,
    analyticsHits,
    analyticsDaily,
    analyticsVisitMembers,
  ],
});

export const analyticsMirrorContributions = [
  MirrorSet(analyticsMirror),
  NeverMirrored({
    tables: [analyticsSalts, analyticsVisitorLinks],
    reason:
      "the daily salts and the hash → visitor links are what makes a visitor's hash reproducible from their IP; they stay on the box and are forgotten after the identity window",
  }),
];
