import { expect, test } from "bun:test";
import { manualSourceType } from "./source-type";

// `runId` and `job` are required by `ProbeContext` but nothing this type does reads them —
// the fingerprint keys upstream material, and this type has none.
const job = { sleep: () => Promise.resolve() };
const ctx = { sourceId: "evs-manual", config: {}, runId: "run-1", job };

test("probe reports a stable, non-null fingerprint", async () => {
  const first = await manualSourceType.probe(ctx);
  const second = await manualSourceType.probe(ctx);

  // Non-null matters as much as stable. `null` is the engine's "cannot
  // fingerprint, ALWAYS extract" declaration, which would leave the
  // disappearance path reachable on every run of every manual source forever.
  expect(first.fingerprint).not.toBeNull();
  // Stable is what makes `fingerprint === lastFingerprint` true from the second
  // run on, so the engine returns `unchanged` without reaching `extract`.
  expect(second.fingerprint).toBe(first.fingerprint);
});

test("probe is stable across sources — the material is never a source's own", async () => {
  // Nothing in the fingerprint depends on the row, because nothing a manual
  // source could import depends on the row either.
  const a = await manualSourceType.probe({
    sourceId: "a",
    config: {},
    runId: "run-a",
    job,
  });
  const b = await manualSourceType.probe({
    sourceId: "b",
    config: {},
    runId: "run-b",
    job,
  });
  expect(a).toEqual(b);
});
