import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ReportKind } from "@plugins/reports/server";
import {
  PAGE_DOC_RANK_DRIFT_KIND,
  PageDocRankDriftPayloadSchema,
  pageDocRankDriftFingerprint,
  pageDocRankDriftReport,
  renderPageDocRankDriftTask,
} from "./internal/page-doc-rank-drift";

export default {
  description:
    "Page doc-rank drift report kind: files the page editor's docRankDriftSink — a boot reconcile that had to re-mint `page_blocks.doc_rank` the structural-write chokepoint should already have kept in document order (a writer bypassed the doc-order marks, or an old backend wrote during a hot-swap) — deduped on the kind alone, with an investigation task naming the bypass to find.",
  contributions: [
    ReportKind({
      kind: PAGE_DOC_RANK_DRIFT_KIND,
      schema: PageDocRankDriftPayloadSchema,
      fingerprint: pageDocRankDriftFingerprint,
      meta: {
        tag: "[page-doc-rank]",
        notif: "Page order needed repair at boot",
        variant: "warning",
      },
      renderTask: renderPageDocRankDriftTask,
    }),
  ],
  sinkHandlers: [pageDocRankDriftReport],
} satisfies ServerPluginDefinition;
