import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  SLOW_PAGE_LOAD_KIND,
  slowPageLoadFingerprint,
  SlowPageLoadPayloadSchema,
} from "../core";
import { renderSlowPageLoadTask } from "./internal/task";

export default {
  description:
    "The slow-page-load report kind on the site's server: the schema and fingerprint (one row per slowest stretch × phone or not) the site's intake identifies a visitor's slow load by.",
  contributions: [
    ReportKind({
      kind: SLOW_PAGE_LOAD_KIND,
      schema: SlowPageLoadPayloadSchema,
      fingerprint: slowPageLoadFingerprint,
      meta: {
        tag: "[slow-page-load]",
        notif: "A page loaded slowly",
        variant: "warning",
        category: "slow-op",
      },
      renderTask: renderSlowPageLoadTask,
    }),
  ],
} satisfies ServerPluginDefinition;
