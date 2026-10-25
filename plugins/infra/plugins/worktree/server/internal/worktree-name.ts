import { attemptIdKind } from "@plugins/tasks/plugins/task-ids/core";

// Canonical worktree-id shape (attempt id == fork DB name == registry entry
// name): an attempt id, read from the attempt id KIND rather than re-typed here
// — `att-<epoch>-<suffix>`, the legacy `claude-` alias (suffix-less
// `claude-<epoch>` included) and any other form `attemptIdKind` recognises. It
// is anchored, so the per-build data files that share the registry dir
// (`<name>-build-profile.json`, `<name>-build-logs-<id>.json`), the reserved
// main-namespace/`central` namespaces, composition ids, `spare-*` checkouts and
// `*__forking` temps are all refused.
//
// One source of truth for everything that has to tell a worktree checkout's
// name apart from another name on the same axis: worktree cleanup's fork-DB,
// registry-file and on-disk dir scans, its delete handlers' id validation, and
// the backup's database selection.
//
// DO NOT WIDEN IT TO ADMIT DOTTED NAMES: a composition's checkout namespace
// (`sonata.att-X`) is a different kind of thing, reclaimed by its marker (see
// `worktree/reclaim`), not by worktree cleanup.
export function isCanonicalWorktreeName(name: string): boolean {
  return attemptIdKind.is(name);
}
