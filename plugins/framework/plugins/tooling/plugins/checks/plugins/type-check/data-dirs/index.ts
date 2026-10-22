import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The per-file lint result store: each file's raw lint messages per part (each
 * syntactic rule group, the typed part, or a directive file whole), keyed by
 * the file's version — its git blob sha — plus whether its text carries an
 * eslint directive.
 *
 * Its own declaration rather than a second entry under the parent check
 * runner's, because the two caches are keyed on different things and are
 * reclaimed independently: the parent's is keyed on (tree hash, check id),
 * this one on a file's content, which is what lets a fresh worktree reuse
 * results recorded by a sibling.
 *
 * `-v3` because it replaced `-v2` on 2026-10-21: a version is a blob sha now,
 * not the sha256 of the text, so the old keys cannot be read as new.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/lint-results.ts
 */
export const lintResultsV3Dir = defineDataDir({
  kind: "cache",
  name: "type-check-lint-results-v3",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per-file raw lint messages per rule group and typed part, keyed by the file's git blob sha, host-global so a fresh worktree reuses a sibling's results",
  reclaim: { kind: "safe" },
});

/**
 * The run bases' ROOTS: per checked tree, the lint state a completed run
 * ended in — the global inputs it holds under (every rule group's
 * fingerprint, the typed parts', the overlay) and a map of shard id → shard
 * content hash. Plus the pointers (tree hash → root) and the per-worktree
 * "last tree" hints that find one. A root is ~150 KB, one per distinct tree
 * a check ran on, so this directory is bounded tighter than the shards.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/run-base.ts
 */
export const runBaseRootsDir = defineDataDir({
  kind: "cache",
  name: "type-check-run-base-roots",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per checked tree: the lint state a completed type-check run ended in (its global inputs and a map of content-addressed shards), plus tree → root pointers and per-worktree last-tree hints",
  reclaim: { kind: "safe" },
});

/**
 * The run bases' SHARDS: the per-file lint state of one leaf plugin's files
 * (version, directive flag, result key, non-empty messages per part), keyed
 * by the shard's content hash — so roots of nearby trees share every shard
 * their trees agree on, and a run writes only the shards it changed.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/run-base.ts
 */
export const runBaseShardsDir = defineDataDir({
  kind: "cache",
  name: "type-check-run-base-shards",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per-file lint state of one plugin's files (version, result key, messages), content-addressed, shared by every run base root that holds it",
  reclaim: { kind: "safe" },
});

/**
 * The walk bases' ROOTS: per checked tree, the state the type check's walk
 * ended in — the global hash it holds under, the global files, and a map of
 * shard id → shard content hash. Plus the pointers (tree hash → root) and the
 * per-checkout "last walked tree" hints. One per distinct tree a worker ran
 * on, so bounded tighter than the shards.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/walk-base.ts
 */
export const walkBaseRootsDir = defineDataDir({
  kind: "cache",
  name: "type-check-walk-roots",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per checked tree: the state the type check's walk ended in (global hash, global files, a map of content-addressed shards), plus tree → root pointers and per-checkout last-tree hints",
  reclaim: { kind: "safe" },
});

/**
 * The walk bases' SHARDS: one leaf plugin's files as the walk ended — each
 * source file's result key, chosen result, per-name meanings, uses, reads,
 * component and rank — plus the reverse indexes held by the target (who reads
 * each name, who probed each directory), keyed by content hash, so nearby
 * trees share every shard they agree on.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/walk-base.ts
 */
export const walkBaseShardsDir = defineDataDir({
  kind: "cache",
  name: "type-check-walk-shards",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per plugin: each source file's walk state (result key, result, name meanings, reads, rank) and the reverse indexes of who reads it, content-addressed, shared by every walk base root that holds it",
  reclaim: { kind: "safe" },
});

/**
 * RETIRED: the store `lintResultsV3Dir` replaced, keyed on the sha256 of a
 * file's text. Nothing writes or reads it any more, and its entries age out by
 * themselves; declared only so the data-dir audit reads the leftover directory
 * as safe to delete. Drop the declaration once no host has it.
 */
export const retiredLintResultsV2Dir = defineDataDir({
  kind: "cache",
  name: "type-check-lint-results-v2",
  owner: "framework/tooling/checks/type-check",
  description:
    "RETIRED, no longer written: per-file lint messages keyed by the sha256 of the text, replaced by type-check-lint-results-v3 — safe to delete",
  reclaim: { kind: "safe" },
});

/**
 * RETIRED: the closure-keyed lint result store `-v2` replaced.
 * Nothing writes or reads it any more, and its entries age out by themselves;
 * it stays DECLARED only so the data-dir audit (`paths:no-undeclared-data-dirs`)
 * reads the leftover directory on an existing host as this plugin's, safe to
 * delete, rather than as an orphan. Drop the declaration once no host has it.
 */
export const retiredLintResultsDir = defineDataDir({
  kind: "cache",
  name: "type-check-lint-results",
  owner: "framework/tooling/checks/type-check",
  description:
    "RETIRED, no longer written: per-file lint messages keyed by import-closure fingerprint, replaced by type-check-lint-results-v2 (now -v3) — safe to delete",
  reclaim: { kind: "safe" },
});

/**
 * The two-program type check's per-file records: one entry per file TEXT
 * (path, version) — its imports, its resolutions and what they probed, and up
 * to four recent results, each under the result key it is valid for
 * (diagnostics, signature, `.d.ts` hash, per-name records and edges).
 *
 * Content-addressed, host-global: a fresh worktree on a main tree reads the
 * entries main's build wrote, and a run writes only the files it checked.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/name-store.ts
 */
export const nameRecordsDir = defineDataDir({
  kind: "cache",
  name: "type-check-name-records",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per file text (path, version): its imports, resolutions and recent type-check results with per-name records, host-global so a run re-checks only files with no valid result",
  reclaim: { kind: "safe" },
});

/**
 * The emitted `.d.ts` of every checked file, by the hash of its text: what a
 * later program is served for a file it does not hold as source. Plus, per
 * global hash, the program-level diagnostics of that environment.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/name-store.ts
 */
export const contractsDir = defineDataDir({
  kind: "cache",
  name: "type-check-contracts",
  owner: "framework/tooling/checks/type-check",
  description:
    "Emitted .d.ts texts by content hash (what a type-check program is served for a file it does not check), host-global",
  reclaim: { kind: "safe" },
});

/**
 * RETIRED: step 1c's checked-results store (per unit key), replaced by
 * `nameRecordsDir`. Declared only so the data-dir audit reads the leftover
 * directory as safe to delete. Drop the declaration once no host has it.
 */
export const retiredFileResultsDir = defineDataDir({
  kind: "cache",
  name: "type-check-file-results",
  owner: "framework/tooling/checks/type-check",
  description:
    "RETIRED, no longer written: per unit key tsc results of the whole-program keyed check, replaced by type-check-name-records — safe to delete",
  reclaim: { kind: "safe" },
});

/**
 * RETIRED: the program-PASS record (per whole-program content key). The
 * two-program check has no whole program to key. Declared only so the
 * data-dir audit reads the leftover directory as safe to delete.
 */
export const retiredProgramPassDir = defineDataDir({
  kind: "cache",
  name: "type-check-programs",
  owner: "framework/tooling/checks/type-check",
  description:
    "RETIRED, no longer written: per-program tsc verdicts keyed by whole-program content — safe to delete",
  reclaim: { kind: "safe" },
});

/**
 * RETIRED: the signature tables (per whole-program key, every file's type
 * fingerprint). Typed lint is keyed on each file's result key now, which the
 * worker computes. Declared only so the data-dir audit reads the leftover
 * directory as safe to delete.
 */
export const retiredTypeFpTablesDir = defineDataDir({
  kind: "cache",
  name: "type-check-type-fps",
  owner: "framework/tooling/checks/type-check",
  description:
    "RETIRED, no longer written: per-program signature tables of type fingerprints — safe to delete",
  reclaim: { kind: "safe" },
});

/**
 * RETIRED: the contract-refs store of the step 1b/1c type fingerprint. Declared only
 * so the data-dir audit reads the leftover directory as safe to delete. Drop
 * the declaration once no host has it.
 */
export const retiredContractRefsDir = defineDataDir({
  kind: "cache",
  name: "type-check-contract-refs",
  owner: "framework/tooling/checks/type-check",
  description:
    "RETIRED, no longer written: per (file, signature) contract specifiers — safe to delete",
  reclaim: { kind: "safe" },
});

export default [
  lintResultsV3Dir,
  runBaseRootsDir,
  runBaseShardsDir,
  walkBaseRootsDir,
  walkBaseShardsDir,
  retiredLintResultsV2Dir,
  retiredLintResultsDir,
  nameRecordsDir,
  contractsDir,
  retiredFileResultsDir,
  retiredProgramPassDir,
  retiredTypeFpTablesDir,
  retiredContractRefsDir,
];
