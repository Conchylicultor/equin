import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
import {
  BOUNDARY_CONFIG,
  COMPOSITIONS_MANIFEST,
  COMPOSITIONS_SOURCE,
  pluginRefsScan,
  scannersFor,
} from "./refs.scan";
import type { PluginRef, PluginRefKind } from "./types";

/**
 * How a pass scans files: plugin-records' `scanRepoFiles` (file records in the
 * process's record store, so only a file whose blob it has not scanned is
 * read). Taken
 * as a parameter because this barrel is in the backend's closure (relocate
 * reads its scanners) and the record store's is build tooling.
 */
export type ScanFiles = <T>(
  repo: RepoFiles,
  files: readonly string[],
  scanner: FileScan<T>,
) => Promise<T[]>;

export interface FindPluginRefsOptions {
  /** Only these kinds (default: all three). */
  kinds?: readonly PluginRefKind[];
  scanFiles: ScanFiles;
}

/**
 * Every plugin reference in the repo, in file order:
 *
 *  - `path` — `plugins/…` path literals and `@plugins/…` specifiers in every
 *    `.ts`/`.tsx` file (test code included — a test that names a plugin by
 *    path names it; `*.generated.ts` excluded — a build rewrites those);
 *  - `dot` — ids read structurally: the compositions manifest (and its
 *    `defineConfig` source), reorder override
 *    `items` keys under `config/`, `asPluginId("…")` in non-test code, and the
 *    boundary config's `runtimeExceptions`;
 *  - `relative` — relative targets in every `*.md` and `@source`/`@import` in
 *    every `*.css`.
 *
 * A mover finds what a relocation must touch from this one list: the path/dot
 * refs whose plugin dir (`pluginDirOfRef`) is inside the moved subtree, and the
 * relative refs whose source file or resolved target (`resolveRelativeRef`) is.
 * Each ref's `range` is exact, so edits apply back-to-front per file.
 */
export async function findPluginRefs(
  repo: RepoFiles,
  options: FindPluginRefsOptions,
): Promise<PluginRef[]> {
  const kinds = new Set<PluginRefKind>(
    options.kinds ?? ["path", "dot", "relative"],
  );
  if (kinds.has("dot")) {
    // Fixed inputs: a missing one is a moved file, not "no refs".
    for (const required of [
      COMPOSITIONS_MANIFEST,
      COMPOSITIONS_SOURCE,
      BOUNDARY_CONFIG,
    ]) {
      if (!repo.has(required)) {
        throw new Error(`plugin-refs: ${required} is missing — was it moved?`);
      }
    }
  }
  const files = repo
    .all()
    .filter((path) => scannersFor(path, kinds).length > 0);
  // A file's refs are a function of its bytes, its path and the scanners'
  // code: file records, so a pass reads only the files whose blob it has not
  // scanned yet. Every kind is read (one record per file, whatever a pass
  // asks for — `pluginRefsScan`), and the kinds not asked for dropped here.
  const perFile = await options.scanFiles(repo, files, pluginRefsScan);
  return perFile.flat().filter((ref) => kinds.has(ref.kind));
}
