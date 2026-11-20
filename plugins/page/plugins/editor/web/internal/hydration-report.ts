import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * Why a block's rendered text stopped agreeing with its content doc. The two
 * arms are the two sides that can fall behind, and telling them apart is the
 * whole diagnostic value of the report — the recovery is the same either way.
 */
export type CollabHydrationReason =
  /** The editor renders nothing while its own content doc holds text: this
   *  binding never received the post-attach `observeDeep` events that are
   *  `@lexical/yjs`'s ONLY ingest path, so it would render empty forever. */
  | "blind-binding"
  /** The content doc is empty while the block's row projection holds text this
   *  client never typed: the doc is behind the SERVER — the `page-block-doc`
   *  push that would have hydrated it never arrived. */
  | "starved-doc";

export interface CollabHydrationReport {
  reason: CollabHydrationReason;
  blockId: string;
  /** Plain-text length the editor was rendering. */
  shownLength: number;
  /** Plain-text length the block's content doc holds. */
  docLength: number;
  /** Plain-text length the row's `data.text` projection holds. */
  rowLength: number;
}

/**
 * A block whose text stopped rendering is recovered in place (re-read +
 * re-attach), which is exactly why it must also be REPORTED: a silent self-heal
 * is indistinguishable from a bug that never happened, and this one was invisible
 * for long enough to be reported by a human instead of by the app.
 *
 * The editor must not import `reports`, so it emits a neutral body into this
 * module-level sink and a domain plugin registers the mapping — the same
 * inversion `caretFlightReportSink` uses. Inert (a no-op) until one does.
 */
export const collabHydrationReportSink =
  defineReportSink<CollabHydrationReport>(
    "page/plugins/editor:collabHydrationReportSink",
  );
