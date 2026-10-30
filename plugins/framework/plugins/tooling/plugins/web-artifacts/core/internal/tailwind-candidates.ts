// The Tailwind class candidates one artifact contributes to the global
// stylesheet: what Tailwind's own scanner extracts from exactly the files the
// artifact's address hashed (`listOwnFiles`). Recorded in the artifact's meta at
// build time, so they are content-addressed with it, shared by every worktree,
// and never re-extracted for an artifact the store reuses. The global
// stylesheet is compiled from the union over the composition's artifacts
// (`global-css.ts`): no file walk and no fingerprint of `plugins/`.
//
// Extraction goes through the scanner's file path, each file one source,
// never `scanFiles` on raw content: the scanner applies per-file rules (a `.css`
// file is read differently), and the content path disagrees with the
// stylesheet's own scan — measured: 464 extra candidates. Per-file sources give
// the same set as the scan over the same files.

import { basename, dirname } from "node:path";

const GLOB_META_RE = /[*?{}[\]!]/;

/** Sorted, deduplicated candidates of `files` (absolute paths). */
export async function tailwindCandidatesOf(
  files: readonly string[],
): Promise<string[]> {
  if (files.length === 0) return [];
  for (const file of files) {
    if (GLOB_META_RE.test(basename(file))) {
      // A source is a glob: a name holding a metacharacter would match other
      // files, or none, and the stylesheet would silently miss its classes.
      throw new Error(
        `tailwind candidates: ${file} has a glob metacharacter in its name, which a scanner source cannot spell`,
      );
    }
  }
  // Lazy: the native scanner loads only when an artifact actually builds.
  const { Scanner } = await import("@tailwindcss/oxide");
  const scanner = new Scanner({
    sources: files.map((file) => ({
      base: dirname(file),
      pattern: basename(file),
      negated: false,
    })),
  });
  return [...new Set(scanner.scan())].sort();
}
