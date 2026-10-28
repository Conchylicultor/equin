import type { PriceTable } from "../../core";

// ─── Vendored LiteLLM snapshot ────────────────────────────────────────────────
//
// A FLOOR, not the source of truth. Its only job is to make the very first boot
// on a machine with no persisted price table — and no network — produce real
// numbers instead of a corpus full of unknown-model buckets. `mergePriceTable`
// layers every fetched table on top of it, and never deletes a key, so this
// snapshot going stale can only ever leave prices that upstream has since
// dropped — which is exactly what we want it to do.
//
// ── Why the rates live in a sibling `.json` and not in this file ─────────────
//
// They are vendored DATA, not code: hundreds of rows nobody hand-edits, regenerated
// wholesale by the command below. Holding them as a `.ts` const also put 154
// literal Claude model ids into a `.ts` file, which is what
// `model-provider:no-raw-model-flags` exists to forbid — and rightly so: the
// check cannot tell a vendored price key from a hardcoded CLI flag, and the
// honest fix is to stop presenting the table as source. A dynamic `import()` of
// JSON is bundled by Bun like any other module, so this survives
// `bun build --compile` into a release artifact; it is not a runtime filesystem
// read.
//
// The JSON sits HERE rather than under `shared/` (where the analogous tweakcn
// community catalog lives) because `shared/` means "web↔server DRY within this
// plugin", and this data is server-only — colocating it with its single
// consumer is the more honest placement.
//
// Refresh it — after a LiteLLM pricing change worth vendoring, and whenever a
// model joins `BASELINE_MODELS` (the price-table test fails until the snapshot
// carries it) — with:
//
//   ./equin run plugins/stats/plugins/cost/scripts/refresh-litellm-fallback.ts
//
// which merges a fresh `fetchPriceTable()` over this snapshot (`mergePriceTable`:
// the floor never loses a key) and rewrites the JSON. Its `fetchedAt` is the
// stamp of the last refresh, never moved by a read.

// Memoized as a PROMISE (not the resolved value) so concurrent first callers
// share one parse instead of racing two. Lazy also keeps ~41 KB of rates off the
// boot path — only a process that actually prices a bucket with no persisted
// table ever pays for it.
let fallbackPromise: Promise<PriceTable> | undefined;

/** The vendored table, ready for `mergePriceTable` to layer a fetched one on top. */
export function loadFallbackPriceTable(): Promise<PriceTable> {
  if (fallbackPromise === undefined) {
    fallbackPromise = import("./litellm-fallback.json").then(
      (mod) => mod.default as PriceTable,
    );
  }
  return fallbackPromise;
}
