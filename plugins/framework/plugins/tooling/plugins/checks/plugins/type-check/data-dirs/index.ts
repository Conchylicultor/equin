import { defineDataDir } from "@plugins/infra/plugins/paths/core";

/**
 * The per-file lint result store: each file's raw lint messages per part (each
 * syntactic rule group, the typed part, or a directive file whole), keyed by
 * the file's own content hash.
 *
 * Its own declaration rather than a second entry under the parent check
 * runner's, because the two caches are keyed on different things and are
 * reclaimed independently: the parent's is keyed on (tree hash, check id),
 * this one on a file's content, which is what lets a fresh worktree reuse
 * results recorded by a sibling.
 *
 * `-v2` because it replaced the closure-keyed store below on 2026-10-17: the
 * two keys mean different things, so the old entries cannot be read as new.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/lint-results.ts
 */
export const lintResultsV2Dir = defineDataDir({
  kind: "cache",
  name: "type-check-lint-results-v2",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per-file raw lint messages per rule group and typed part, keyed by the file's content hash, host-global so a fresh worktree reuses a sibling's results",
  reclaim: { kind: "safe" },
});

/**
 * RETIRED: the closure-keyed lint result store `lintResultsV2Dir` replaced.
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
    "RETIRED, no longer written: per-file lint messages keyed by import-closure fingerprint, replaced by type-check-lint-results-v2 — safe to delete",
  reclaim: { kind: "safe" },
});

/**
 * The program-PASS record.
 *
 * A sibling of the lint result store rather than a namespace inside it: the two are
 * keyed on different things (a file's content vs a whole tsc program's
 * content) and are bounded independently — this one holds a handful of entries
 * per run where that one holds thousands. The data-dir declaration is the
 * reclaim audit's description of what lives on disk, so two stores are two
 * declarations.
 *
 * Host-global for the same reason: a program key is content-addressed, so a
 * fresh worktree skips a program that main — or a sibling — already passed on
 * an identical tree.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/program-key.ts
 */
export const programPassDir = defineDataDir({
  kind: "cache",
  name: "type-check-programs",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per-tsc-target program verdicts keyed by the content of everything the program loaded, host-global so an unaffected target is not re-checked",
  reclaim: { kind: "safe" },
});

/**
 * The signature tables: per program key, every lintable file's type
 * fingerprint in that program. What lets prepare decide every file's typed
 * lint part BEFORE the worker runs — and so skip the worker outright — on a
 * program some run already built.
 *
 * A sibling of the PASS record, keyed the same way, but its own store: a table
 * is recorded whatever the program's verdict (signatures are facts of the
 * program, not of whether it type-checks), and its entries are ~200 KB where a
 * PASS is a few bytes, so the two are bounded apart.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/check/type-fp-tables.ts
 */
export const typeFpTablesDir = defineDataDir({
  kind: "cache",
  name: "type-check-type-fps",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per-program signature tables (every lintable file's type fingerprint), keyed by program content, host-global so a run on an already-built program decides its typed lint before spawning a worker",
  reclaim: { kind: "safe" },
});

/**
 * The checked-results store: per unit key — a hash of a file's text and of
 * every declaration its check can see — that file's tsc diagnostics, its
 * signature, and what its `.d.ts` names. What lets a run re-check only the
 * files whose key moved.
 *
 * Content-addressed, host-global: a fresh worktree reuses what any worktree
 * checked for the same key.
 *
 * @see plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/keyed-check.ts
 */
export const fileResultsDir = defineDataDir({
  kind: "cache",
  name: "type-check-file-results",
  owner: "framework/tooling/checks/type-check",
  description:
    "Per unit key (a file's text and every declaration its check sees) its tsc diagnostics, signature and contract specifiers, host-global so only files whose key moved are re-checked",
  reclaim: { kind: "safe" },
});

/**
 * RETIRED: the contract-refs store, superseded by `fileResultsDir`, which
 * holds each checked file's specifiers with its other results. Declared only
 * so the data-dir audit reads the leftover directory as safe to delete. Drop
 * the declaration once no host has it.
 */
export const retiredContractRefsDir = defineDataDir({
  kind: "cache",
  name: "type-check-contract-refs",
  owner: "framework/tooling/checks/type-check",
  description:
    "RETIRED, no longer written: per (file, signature) contract specifiers, replaced by type-check-file-results — safe to delete",
  reclaim: { kind: "safe" },
});

export default [
  lintResultsV2Dir,
  retiredLintResultsDir,
  programPassDir,
  typeFpTablesDir,
  fileResultsDir,
  retiredContractRefsDir,
];
