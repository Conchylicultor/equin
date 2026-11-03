// Causal comparator for Postgres transaction watermarks. Both the ack token a
// mutation endpoint returns (`pg_current_xact_id()::text`, Rule A) and the
// snapshot watermark a live-state frame carries
// (`pg_snapshot_xmin(pg_current_snapshot())::text`, Rule B) are xid8 values
// rendered as decimal text. xid8 is a 64-bit epoch-qualified transaction id, so
// it overflows Number.MAX_SAFE_INTEGER in practice and its decimal text is not
// lexicographically ordered ("9" > "10") — compare as BigInt, never as number
// or string. See research/2026-07-11-global-never-revert-optimistic-edits.md.

/**
 * Compare two transaction watermarks (xid8 decimal text): -1 if `a` is causally
 * older than `b`, 0 if equal, 1 if newer. The load-bearing use is Rule B: a
 * snapshot may DENY an optimistic op only under strict
 * `compareTxWatermark(snapshotWatermark, ackToken) > 0` — the snapshot then
 * provably saw the op's commit (or its overwrite). Throws (BigInt coercion) on
 * non-numeric input — a malformed watermark is a bug, never a silent "older".
 */
export function compareTxWatermark(a: string, b: string): -1 | 0 | 1 {
  const av = BigInt(a);
  const bv = BigInt(b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}
