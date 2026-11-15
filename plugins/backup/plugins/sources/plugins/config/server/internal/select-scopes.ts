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
//
// Only a DIRECTORY is a namespace subtree. config_v2 writes nothing loose at
// the top level, but other things do: Finder drops a `.DS_Store` into any
// folder it opens, and classifying that file as an "orphan namespace" made the
// stager glob inside a file (ENOTDIR, report-1794452517-7v3y31). A loose file
// is its own kind: copied as a file — it may be something the user put there —
// unless a declared rule below names it as noise.

/** Top-level file names left out of the archive, each with why. */
export const IGNORED_LOOSE_FILES: ReadonlyMap<string, string> = new Map([
  [
    ".DS_Store",
    "Finder's folder view settings, written whenever the folder is opened in Finder — no config",
  ],
]);

export interface TopLevelEntry {
  name: string;
  isDirectory: boolean;
}

export type ScopeKind = NamespaceKind | "loose-file" | "ignored";

export interface ClassifiedScope {
  name: string;
  kind: ScopeKind;
}

/** Pure: the marker probe is an argument (`hasCompositionMarker` in production). */
export async function classifyScopes(
  entries: readonly TopLevelEntry[],
  hasMarker: (ns: Namespace) => Promise<boolean>,
): Promise<ClassifiedScope[]> {
  return Promise.all(
    entries.map(async ({ name, isDirectory }): Promise<ClassifiedScope> => {
      if (!isDirectory) {
        return {
          name,
          kind: IGNORED_LOOSE_FILES.has(name) ? "ignored" : "loose-file",
        };
      }
      return { name, kind: await classifyNamespace(name, hasMarker) };
    }),
  );
}

/** The entries the archive takes: every kind nothing reaps, minus declared noise. */
export function backedUpScopes(
  classified: readonly ClassifiedScope[],
): ClassifiedScope[] {
  return classified.filter(
    (s) => s.kind !== "worktree" && s.kind !== "ignored",
  );
}

// The run card's "Not backed up" list: the worktree subtrees as ONE line of
// counts, then each ignored loose file with its declared reason.
export function describeLeftOut(
  classified: readonly ClassifiedScope[],
): BackupSourceItem[] {
  const items: BackupSourceItem[] = [];
  const worktrees = classified.filter((s) => s.kind === "worktree").length;
  if (worktrees > 0) {
    items.push({
      label: `${worktrees} worktree config ${worktrees === 1 ? "copy" : "copies"}`,
      detail: "disposable, reaped with their checkout, never backed up",
      count: worktrees,
    });
  }
  for (const s of classified) {
    if (s.kind !== "ignored") continue;
    items.push({
      label: s.name,
      detail: IGNORED_LOOSE_FILES.get(s.name),
      count: 1,
    });
  }
  return items;
}
