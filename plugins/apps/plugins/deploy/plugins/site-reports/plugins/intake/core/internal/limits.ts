/**
 * Every bound of the public report intake, as data — the server enforces them
 * and the site's channel sizes its batches to them. A public route is bounded
 * at every layer by these numbers alone: nothing here scales with traffic.
 */
export const SITE_REPORT_LIMITS = {
  /** One POST's declared body, refused (413) before it is read. */
  maxBodyBytes: 64 * 1024,
  /** Reports in one batch. */
  maxBatch: 10,
  /** One report's one-line summary, in characters. */
  maxMessage: 1_000,
  /** One report's kind payload, serialized. */
  maxDataBytes: 4_096,
  /** One string inside a report's kind payload, in characters (the page clamps). */
  maxDataString: 1_500,
  /** Occurrences the browser folded into one entry. */
  maxCount: 1_000,
  /** The admission window: per-visitor and global batch budgets refill each one. */
  windowMs: 60_000,
  /** Batches one visitor (salted IP hash) may post per window. */
  perVisitorBatches: 6,
  /** Batches every visitor together may post per window. */
  globalBatches: 600,
  /** Visitors the admission gate tracks per window; past it a new one is refused. */
  maxTrackedVisitors: 10_000,
  /** Distinct fingerprints held between two flushes. */
  maxPending: 500,
  /** Rows `site_reports` may hold; past it a NEW fingerprint is dropped (counted). */
  maxRows: 2_000,
  /** How long a fingerprint unseen is kept, and a drop-count row. */
  retentionDays: 30,
} as const;

/**
 * Why an entry (or a whole batch) wrote no row of its own. Every one is
 * counted in `site_report_drops`, per window — never queued, never silent.
 */
export const SITE_REPORT_DROP_REASONS = [
  // The visitor spent their batches for this window.
  "visitor-budget",
  // Every visitor together spent the window's batches.
  "global-budget",
  // The gate already tracks maxTrackedVisitors this window.
  "visitor-roster",
  // No ReportKind of that name is registered on this server.
  "unknown-kind",
  // The kind's payload schema refused the entry's data.
  "invalid-data",
  // A new fingerprint past the reports fan-out ceiling (per kind, per window).
  "fan-out",
  // A new fingerprint while maxPending were already waiting for the flush.
  "pending-cap",
  // A new fingerprint while the table holds maxRows.
  "row-cap",
] as const;
export type SiteReportDropReason = (typeof SITE_REPORT_DROP_REASONS)[number];
