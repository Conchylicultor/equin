// type-check's OUTER input-keyed read-set (see the plan
// research/2026-07-17-global-input-keyed-check-cache.md §2.5 + Stage 2).
//
// The OUTER whole-tree cache used to force type-check.run() to rebuild the import
// graph and spawn the full tsc worker fleet on ANY tree change — even a docs-only
// one — because its verdict was keyed on the entire working-tree hash. (Its INNER
// per-file lint result store only skips the *lint* stage, never the tsc fan-out.)
//
// This module records, into the ambient recording `FileSystemView`, EVERY input
// type-check's verdict depends on, so validate-by-replay makes a change touching
// none of them an outer HIT (zero workers) while any verdict-relevant change is a
// MISS. It is purely ADDITIVE to run(): on a MISS the body runs exactly as before
// (the inner lint result store still applies); on a HIT the runner short-circuits and
// run() is never called.

import type { FileSystemView } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { lintableFiles } from "./import-graph";
import { findGlobalTriggerFiles } from "./fingerprint";

/**
 * Record type-check's outer read-set into `view` (a no-op caller-side when the
 * view is null — the legacy whole-tree path). Three input sets, each mapped to a
 * recorded fact so `validate` re-derives it against the next snapshot:
 *
 *  (a) MEMBERSHIP of the type/config namespaces — glob facts over every `.ts` /
 *      `.tsx` (the lintable + tsc universe, incl. `.d.ts`) and every
 *      `tsconfig*.json`. This is the COVERAGE-GATE guard (hazard H3): a BRAND-NEW
 *      `.ts` — which the gate must FAIL if it is not a root of the program —
 *      ADDS a member, so the glob match set changes → MISS → re-run → the gate
 *      fires.
 *      A content-only read-set records only files that already exist, so it would
 *      NOT see a new file and would stale-PASS the gate; the membership fact is
 *      what closes that hole. A new `tsconfig*.json` is caught the same way.
 *      This fact and the lintable set beside it now answer "which `.ts` files
 *      exist" from the SAME tree — the glob filters the snapshot, and
 *      `lintableFiles` filters that snapshot's paths. Before, the listing came
 *      from a filesystem walk, so the recorded fact and the scanned set
 *      disagreed on exactly the gitignored files.
 *  (b) CONTENT of every lintable file (`lintableFiles(paths)` — the SAME
 *      function the preparation filters with, over the same tree, so the
 *      recorded set is the linted set by construction) as `(path, blobSha)`
 *      facts, so ANY `.ts`/`.tsx` edit is a MISS (the type graph changed) while
 *      a non-source change stays a HIT.
 *  (c) CONTENT of the global-trigger set (`findGlobalTriggerFiles` — the SAME
 *      enumeration `globalConfigFingerprint` folds: tsconfig*, package.json,
 *      bun.lock(b), *.d.ts, eslint.config.ts, plugins/**\/lint/**,
 *      plugins/**\/exempt/** (exemption manifests),
 *      *.lint.generated.ts). This is what makes a TypeScript compiler version
 *      bump (package.json / bun.lock) or a tsconfig/eslint change invalidate.
 *
 * Blob SHAs come from the snapshot the view already wraps (`recordFile` reads no
 * bytes, `glob` is a regex filter over the loaded path set) — a pure in-memory
 * projection, so recording spawns nothing and never touches tsc. This must stay
 * cheap: it runs on the MISS path, on the check runner's own thread, before the
 * preparation thread starts — which is why it takes the snapshot's paths and
 * reads nothing.
 */
export function recordOuterReadSet(
  view: FileSystemView,
  paths: readonly string[],
): void {
  // (a) Membership of the namespaces whose ADDITIONS can flip the verdict.
  //     `*.ts` (superset regex) spans all depths and also covers `*.d.ts`,
  //     lint-rule `.ts`, and `*.lint.generated.ts`; `*.tsx` the JSX sources;
  //     `*tsconfig*.json` any new tsconfig at any depth. Over-matching only
  //     over-invalidates (safe); it can never miss a new file.
  view.glob("*.ts");
  view.glob("*.tsx");
  view.glob("*tsconfig*.json");
  // (b) Contents of the exact lintable set the check considers.
  for (const rel of lintableFiles(paths)) view.recordFile(rel);
  // (c) Contents of the global-trigger set.
  for (const rel of findGlobalTriggerFiles(paths)) view.recordFile(rel);
}
