import { z } from "zod";

// The optimistic-divergence report payload, stored in the generic `data` jsonb
// column and validated on ingest by the optimistic-divergence ReportKind.
// Mirrors `OptimisticDivergenceReport`, the neutral body the optimistic-mutation
// primitive emits into its report sink — this schema is the ingest-side contract
// for that same shape.
export const OptimisticDivergencePayloadSchema = z.object({
  // How the primitive classified the divergence: `superseded` = the op was
  // DROPPED because a snapshot causally past its commit (the watermark rules)
  // still lacked its effect — newer server truth won, the healthy outcome;
  // `stalled` = the op is KEPT rendered (never-revert) but crossed the miss
  // threshold — the one-shot investigation signal for a wrong
  // `apply`/`isConfirmedBy` pair.
  kind: z.enum(["superseded", "stalled"]),
  // The live-state resource key whose overlay op diverged.
  resourceKey: z.string(),
  // The resource params the diverging consumer subscribed with, if any.
  params: z.record(z.string(), z.string()).nullable(),
  // The consumer's `label` ("what is being saved"), if it passed one.
  label: z.string().nullable(),
  // Consecutive authoritative pushes that had failed to confirm the op when the
  // report fired. Volatile — deliberately excluded from the fingerprint.
  misses: z.number(),
  // Per-op `describeOp(vars)` summaries for the reported ops (never raw vars,
  // which are unbounded and possibly unserializable).
  opSummaries: z.array(z.string()),
});
export type OptimisticDivergencePayload = z.infer<
  typeof OptimisticDivergencePayloadSchema
>;

// Read-side twin for `_reports` rows stored BEFORE `kind` existed (pre
// never-revert): every legacy report was the miss-threshold signal, so the
// missing discriminant heals to `stalled`. Ingest stays strict (the collector
// always emits an explicit kind) — only stored-row readers (the server
// renderTask, the Debug summary view) parse with this, so a count-bump
// re-render of a legacy row never fails.
export const StoredOptimisticDivergencePayloadSchema =
  OptimisticDivergencePayloadSchema.extend({
    kind: OptimisticDivergencePayloadSchema.shape.kind.default("stalled"),
  });

// Divergence fingerprint = sha256(kind + resourceKey + label + opSummaries),
// first 16 hex chars. `kind` is INCLUDED: a healthy superseded drop and a
// stalled correctness signal on the same surface are different findings and
// must not dedupe onto one row. `misses` is EXCLUDED: it is the miss count at
// the instant one particular op reported, so it varies between
// otherwise-identical repeats of the same bug. Including it would split one
// broken `apply`/`isConfirmedBy` pair across several rows. `params` is also
// excluded — the same buggy pair diverges on every page/conversation it is
// used with, and those are one bug, not N.
export async function optimisticDivergenceFingerprint(
  data: OptimisticDivergencePayload,
): Promise<string> {
  const input = `${data.kind}|${data.resourceKey}|${data.label ?? ""}|${data.opSummaries.join(",")}`;
  return sha256Hex(input).then((h) => h.slice(0, 16));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
