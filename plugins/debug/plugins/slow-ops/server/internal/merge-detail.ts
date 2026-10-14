import {
  SPAN_MEASURES,
  type SpanMeasures,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  OTHER_VARIANT,
  VARIANT_CAP,
  type SlowOpMeasures,
  type VariantBreakdown,
} from "../../core";

// Pure merges of a span's detail (variant + measures) into a slow-op row, run
// by the batch fold (fold-batch.ts) and mirrored in SQL by merge-sql.ts. Kept
// apart from the DB funnel so they are testable without a database.

// Merge a variant into the breakdown, then keep it bounded: the top
// VARIANT_CAP by totalMs stay named and everything past them folds into one
// OTHER_VARIANT entry. A variant that has been folded stays folded — its later
// occurrences land on OTHER_VARIANT — unless its own total climbs past the
// smallest named entry; either way the row cannot grow without bound.
export function mergeVariant(
  variants: VariantBreakdown[],
  variant: string,
  durationMs: number,
): VariantBreakdown[] {
  const next = variants.map((v) => ({ ...v }));
  const existing = next.find((v) => v.variant === variant);
  if (existing) {
    existing.count += 1;
    existing.totalMs += durationMs;
    if (durationMs > existing.maxMs) existing.maxMs = durationMs;
  } else {
    next.push({ variant, count: 1, totalMs: durationMs, maxMs: durationMs });
  }
  const named = next
    .filter((v) => v.variant !== OTHER_VARIANT)
    .sort((a, b) => b.totalMs - a.totalMs);
  let other = next.find((v) => v.variant === OTHER_VARIANT);
  for (const v of named.slice(VARIANT_CAP)) {
    other ??= { variant: OTHER_VARIANT, count: 0, totalMs: 0, maxMs: 0 };
    other.count += v.count;
    other.totalMs += v.totalMs;
    if (v.maxMs > other.maxMs) other.maxMs = v.maxMs;
  }
  const kept = named.slice(0, VARIANT_CAP);
  return other ? [...kept, other] : kept;
}

// Fold one span's measures into the row's per-measure { max, last }.
export function mergeMeasures(
  existing: SlowOpMeasures,
  incoming: SpanMeasures,
): SlowOpMeasures {
  const next: SlowOpMeasures = { ...existing };
  for (const m of SPAN_MEASURES) {
    const v = incoming[m];
    if (v === undefined) continue;
    const prev = next[m];
    next[m] = { max: prev ? Math.max(prev.max, v) : v, last: v };
  }
  return next;
}
