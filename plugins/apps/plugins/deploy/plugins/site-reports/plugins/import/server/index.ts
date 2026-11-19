import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { SiteMirrorSink } from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/server";
import { SITE_REPORTS_MIRROR_SET_ID } from "@plugins/apps/plugins/deploy/plugins/site-reports/plugins/intake/core";
import {
  websiteVisitorErrorKind,
  websiteVisitorSlownessKind,
} from "./internal/kind";
import { IMPORT_PACE, reduceSink } from "./internal/reduce-sink";

export default {
  description:
    "Reads the errors and slowness a deployed site's visitors hit into this computer's Reports: the box's site_reports change stream (site-mirror, outbound SSH only) goes through the reduce step as the replica's sink — every row strictly parsed and reduced to typed, clamped fields, the site's payload never copied but reduced structurally (identifier keys, typed scalars, every string a sanitised plain line, capped and counted — so every kind's diagnostic data reaches the local report), no raw row stored here (only the mirror's content-free key index) — at most 50 rows per deployment per hourly run, each page ONE incident, each row of the website-visitor-error or website-visitor-slowness kind by its site kind's own category (so a visitor's slow load or freeze is a slow op here too) (a reconciliation's catch-up rings no bell), source website-visitor — untrusted: never on the worklist automations read, fenced as data when investigated by hand.",
  contributions: [
    websiteVisitorErrorKind,
    websiteVisitorSlownessKind,
    SiteMirrorSink({
      setId: SITE_REPORTS_MIRROR_SET_ID,
      sink: reduceSink,
      pace: IMPORT_PACE,
      reason:
        "A site's error rows are written by anonymous strangers (free text, arbitrary data): only their reduced form may be kept on this computer, so the stream is reduced as it arrives, never copied.",
    }),
  ],
} satisfies ServerPluginDefinition;
