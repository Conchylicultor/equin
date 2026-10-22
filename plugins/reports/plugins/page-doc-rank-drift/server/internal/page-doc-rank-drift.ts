import { z } from "zod";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import type { ReportRow } from "@plugins/reports/server";
import { docRankDriftSink } from "@plugins/page/plugins/editor/server";

export const PAGE_DOC_RANK_DRIFT_KIND = "page-doc-rank-drift";

export const PageDocRankDriftPayloadSchema = z.object({
  /** Rows the boot re-minted. */
  written: z.number().int().nonnegative(),
  /** …of which held a key that no longer fit document order. */
  rekeyed: z.number().int().nonnegative(),
  /** …of which held no key at all (a page inserted without a reconcile). */
  unkeyed: z.number().int().nonnegative(),
  /** The sidebar groups repaired, by page id (`root` for the workspace root). */
  partitions: z.array(z.string()),
});

type PageDocRankDriftPayload = z.infer<typeof PageDocRankDriftPayloadSchema>;

/**
 * Deduped on the kind alone: it is one standing question ("who bypasses the
 * marks?"), whatever groups a given boot happened to repair.
 */
export function pageDocRankDriftFingerprint(): string {
  return PAGE_DOC_RANK_DRIFT_KIND;
}

export function renderPageDocRankDriftTask(row: ReportRow): {
  title: string;
  description: string;
} {
  const d = PageDocRankDriftPayloadSchema.parse(row.data);
  return { title: title(d), description: render(d) };
}

function title(d: PageDocRankDriftPayload): string {
  return `[page-doc-rank] boot re-minted ${d.written} sidebar key${d.written === 1 ? "" : "s"} a writer left out of document order`;
}

function render(d: PageDocRankDriftPayload): string {
  return [
    "**The boot reconcile re-minted `page_blocks.doc_rank` after the column was already maintained.**",
    "",
    "Every structural write re-mints the sidebar groups it touched inside `withPageForest` " +
      "(`plugins/page/plugins/editor/server/internal/doc-rank.ts`), from dirty marks recorded by the " +
      "lowest-level forest mutators (`forest-writer.ts`, `recomputePageIdSubtree`). A boot that still " +
      "finds a group out of order means some write changed a page row's placement without those marks.",
    "",
    `- re-minted rows: ${d.written} (${d.rekeyed} held a key out of order, ${d.unkeyed} held none)`,
    `- groups: ${d.partitions.map((p) => `\`${p}\``).join(", ")}`,
    "",
    "**What to do:** find the writer. Rows with no key point at an INSERT that bypassed " +
      "`insertBlocks`; rows re-keyed point at a reparent, rank or `page_id` change that bypassed " +
      "`updateBlockFields` / `recomputePageIdSubtree`. A single occurrence right after a deploy can be " +
      "the previous backend writing during the hot-swap.",
  ].join("\n");
}

/**
 * File the drift the editor's boot reconcile announces on `docRankDriftSink`.
 * The sink held what the editor's `onReadyBlocking` emitted before this
 * registers, and replays it here.
 */
export function registerPageDocRankDriftReport(): void {
  docRankDriftSink.register((drift) => {
    const data: PageDocRankDriftPayload = {
      written: drift.written,
      rekeyed: drift.rekeyed,
      unkeyed: drift.unkeyed,
      partitions: drift.partitions.map((p) => p ?? "root"),
    };
    void recordReport({
      kind: PAGE_DOC_RANK_DRIFT_KIND,
      source: "server-caught",
      message: title(data),
      data,
    });
  });
}
