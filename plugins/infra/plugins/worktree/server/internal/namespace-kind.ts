import {
  MAIN_WORKTREE_NAME,
  asNamespace,
  isNamespace,
  namespaceParts,
  type Namespace,
} from "@plugins/infra/plugins/namespace/core";
import { isCanonicalWorktreeName } from "./worktree-name";

// What a namespace-named thing on this machine IS — the main app, a composition
// app, a worktree checkout, or nothing anyone owns — decided from the evidence
// its producer left behind, never from a list of name prefixes.
//
// One decision for every per-namespace store that has to tell what outlives a
// checkout from what does not: the backup takes the persistent kinds only (a
// database per namespace, a config subtree per namespace), because a
// worktree's copy is disposable by design and reaped with its checkout — so
// copying it races the reaper and would back up nothing worth restoring.
//
//   - `main` — the main app.
//   - `composition` — a composition app served from main: a single-label
//     namespace with a `composition.json` marker.
//   - `worktree` — a checkout: a single label in the canonical worktree-name
//     grammar (worktree cleanup reaps the ones whose checkout is gone), or a
//     composition's checkout (`sonata.att-X`) recognised by its marker, since
//     reclaiming those is marker-driven too.
//   - `orphan` — none of the above: no app owns it and nothing reclaims it (a
//     composition namespace whose directory is gone, a name that is not a
//     namespace at all).

export type NamespaceKind = "main" | "composition" | "worktree" | "orphan";

/**
 * Pure: the marker probe is an argument (`hasCompositionMarker` in production),
 * so the whole decision is testable without a filesystem.
 */
export async function classifyNamespace(
  name: string,
  hasMarker: (ns: Namespace) => Promise<boolean>,
): Promise<NamespaceKind> {
  if (name === MAIN_WORKTREE_NAME) return "main";
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

/** The kinds whose state is an app's own data and outlives any checkout. */
export function isPersistentNamespace(kind: NamespaceKind): boolean {
  return kind === "main" || kind === "composition";
}
