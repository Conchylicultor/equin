import { isForkTempName } from "@plugins/database/plugins/admin/server";
import { parseTestDbName } from "@plugins/database/plugins/db-test-fixture/core";
import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  classifyNamespace,
  isPersistentNamespace,
  type NamespaceKind,
} from "@plugins/infra/plugins/worktree/server";

// Which databases on the cluster are an app's own data, and so belong in the
// backup — decided by what each database IS. A database named after a
// namespace is that namespace's (`classifyNamespace`: main and compositions
// are backed up, a worktree's fork is disposable, an orphan is named on the
// run card so a person can drop it). Two more kinds exist only on the cluster:
//
//   - `test` — a throwaway test database (`parseTestDbName`, swept hourly).
//   - `fork-temp` — a fork's in-flight temp (`isForkTempName`, swept).
//
// Neither is backed up; both are counted on the run card.

export type DatabaseKind = NamespaceKind | "test" | "fork-temp";

/** The kinds whose rows are an app's own data. */
export function isBackedUp(kind: DatabaseKind): boolean {
  return kind !== "test" && kind !== "fork-temp" && isPersistentNamespace(kind);
}

/**
 * Pure: the marker probe is an argument (`hasCompositionMarker` in production),
 * so the whole decision is testable without a filesystem.
 */
export async function classifyDatabase(
  name: string,
  hasMarker: (ns: Namespace) => Promise<boolean>,
): Promise<DatabaseKind> {
  if (parseTestDbName(name) !== null) return "test";
  if (isForkTempName(name)) return "fork-temp";
  return classifyNamespace(name, hasMarker);
}
