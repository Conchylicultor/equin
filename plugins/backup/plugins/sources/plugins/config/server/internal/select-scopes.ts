import type { Namespace } from "@plugins/infra/plugins/namespace/core";
import {
  classifyNamespace,
  type NamespaceKind,
} from "@plugins/infra/plugins/worktree/server";
import type { BackupSourceItem } from "@plugins/backup/core";

// The config dir holds one subtree per namespace (`classifyNamespace`, the
// databases source's classifier). Every subtree goes in the archive EXCEPT a
// worktree's: it is forked from main's on create and reaped with its checkout
// (`debug/worktree-cleanup`, `worktree/reclaim`), so it is disposable by design
// (like the worktree's database fork), and copying it races the reaper, which
// can remove it mid-copy (report-1794452517-7v3y31).
//
// An orphan subtree IS copied, unlike an orphan database: nothing reclaims it,
// so the copy cannot race anything, and it is small and may hold the only copy
// of a user override (a composition removed by hand). It is still a line of its
// own on the run card, under its name.

export interface ClassifiedScope {
  name: string;
  kind: NamespaceKind;
}

/** Pure: the marker probe is an argument (`hasCompositionMarker` in production). */
export async function classifyScopes(
  names: readonly string[],
  hasMarker: (ns: Namespace) => Promise<boolean>,
): Promise<ClassifiedScope[]> {
  return Promise.all(
    names.map(async (name) => ({
      name,
      kind: await classifyNamespace(name, hasMarker),
    })),
  );
}

/** The subtrees the archive takes: every kind nothing reaps. */
export function backedUpScopes(
  classified: readonly ClassifiedScope[],
): ClassifiedScope[] {
  return classified.filter((s) => s.kind !== "worktree");
}

// The run card's "Not backed up" list: the worktree subtrees as ONE line of
// counts.
export function describeLeftOut(
  classified: readonly ClassifiedScope[],
): BackupSourceItem[] {
  const worktrees = classified.filter((s) => s.kind === "worktree").length;
  if (worktrees === 0) return [];
  return [
    {
      label: `${worktrees} worktree config ${worktrees === 1 ? "copy" : "copies"}`,
      detail: "disposable, reaped with their checkout, never backed up",
      count: worktrees,
    },
  ];
}
