import { isForkTempName } from "@plugins/database/plugins/admin/server";
import { parseTestDbName } from "@plugins/database/plugins/db-test-fixture/core";
import {
  MAIN_WORKTREE_NAME,
  asNamespace,
  isNamespace,
  namespaceParts,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { isCanonicalWorktreeName } from "@plugins/infra/plugins/worktree/server";

// Which databases on the cluster are an app's own data, and so belong in the
// backup — decided by what each database IS, from the evidence its producer
// left behind, rather than by a list of name prefixes to skip.
//
// Backed up:
//   - `main` — the main app's database.
//   - `composition` — a composition app served from main: a single-label
//     namespace with a `composition.json` marker.
//
// Not backed up (counted on the run card):
//   - `worktree` — a checkout's fork of an app's database. Disposable by
//     design, rebuilt by the next fork. A single label is recognised by the
//     canonical worktree-name grammar (worktree cleanup reaps the ones whose
//     checkout is gone); a composition's checkout (`sonata.att-X`) by its
//     marker, since reclaiming those is marker-driven too.
//   - `test` — a throwaway test database (`parseTestDbName`, swept hourly).
//   - `fork-temp` — a fork's in-flight temp (`isForkTempName`, swept).
//
// Not backed up, and NAMED on the run card:
//   - `orphan` — none of the above: no app owns it and nothing reclaims it (a
//     composition namespace whose directory is gone, a test database minted
//     before the test grammar existed). Named so a person can drop it.

export type DatabaseKind =
  "main" | "composition" | "worktree" | "test" | "fork-temp" | "orphan";

/** The kinds whose rows are an app's own data. */
export function isBackedUp(kind: DatabaseKind): boolean {
  return kind === "main" || kind === "composition";
}

/**
 * Pure: the marker probe is an argument (`hasCompositionMarker` in production),
 * so the whole decision is testable without a filesystem.
 */
export async function classifyDatabase(
  name: string,
  hasMarker: (ns: Namespace) => Promise<boolean>,
): Promise<DatabaseKind> {
  if (name === MAIN_WORKTREE_NAME) return "main";
  if (parseTestDbName(name) !== null) return "test";
  if (isForkTempName(name)) return "fork-temp";
  if (!isNamespace(name)) return "orphan";
  const ns = asNamespace(name);
  const parts = namespaceParts(ns);
  if (parts.kind === "label" && isCanonicalWorktreeName(parts.label)) {
    return "worktree";
  }
  // Past the worktree grammar, a single label can only be a composition on
  // main (the elision rule, `namespaceFor`), and two labels a composition's
  // checkout. The marker is what says a live namespace really is one.
  if (!(await hasMarker(ns))) return "orphan";
  return parts.kind === "label" ? "composition" : "worktree";
}
