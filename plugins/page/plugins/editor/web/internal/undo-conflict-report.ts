import { defineReportSink } from "@plugins/primitives/plugins/report-sink/core";

/**
 * Why a data-based text undo entry met a block that was not the one it recorded.
 * The two arms are the two moments a second writer can slip between what an
 * entry captured and what it acts on, and the policy differs per arm — which is
 * why they are reported apart (design: §5 and §6 of
 * `research/2026-09-09-page-data-based-text-undo-entries-v2.md`).
 */
export type UndoConflictReason =
  /** A replay found the block holding something other than what the entry
   *  recorded (`after` on undo, `before` on redo). Under single-writer LIFO the
   *  two always match, so a mismatch is a genuine second writer between record
   *  and replay. The entry is applied ANYWAY — the user asked for their undo —
   *  which clobbers the other writer's text; this report is what makes that
   *  clobber measurable rather than silent. The residual, and the upgrade path
   *  (a runs-level 3-way merge), is documented in `editor/CLAUDE.md`. */
  | "stale-entry"
  /** A remote apply (a server push, another client's edit) landed inside an
   *  open typing run. The run was dropped rather than closed: an entry recorded
   *  across it would carry the remote text as if the user had typed it, and
   *  undoing it would destroy that text. One undo step is lost at a genuinely
   *  concurrent moment; nothing destructive is ever recorded. Also covers the
   *  hydration window, where the first push arrives while a run may be open. */
  | "run-aborted";

export interface UndoConflictReport {
  reason: UndoConflictReason;
  blockId: string;
  /** Which way the replay was running — `null` for `run-aborted`, which
   *  happens while recording, not while replaying. */
  direction: "undo" | "redo" | null;
  /** Plain-text length the entry expected to find (`stale-entry`), or the
   *  length the open run had started from (`run-aborted`). */
  expectedLength: number;
  /** Plain-text length the block actually held at that moment. */
  actualLength: number;
}

/**
 * Both arms are handled in place — the stale entry is applied, the aborted run
 * is dropped — which is exactly why each must also be REPORTED: a policy that
 * absorbs a conflict silently is indistinguishable from one that never meets
 * any, and the residual (clobbering a second writer) is only acceptable while
 * it is measurably rare.
 *
 * The editor must not import `reports`, so it emits a neutral body into this
 * module-level sink and a domain plugin registers the mapping — the same
 * inversion `caretFlightReportSink` and `collabHydrationReportSink` use. Inert
 * (a no-op) until one does.
 */
export const undoConflictReportSink = defineReportSink<UndoConflictReport>(
  "page/plugins/editor:undoConflictReportSink",
);
