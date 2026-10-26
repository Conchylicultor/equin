import {
  asPath,
  asPluginId,
  isTestCodePath,
} from "@plugins/framework/plugins/plugin-id/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import { createTimeSlicer } from "@plugins/packages/plugins/macrotask-yield/core";
import {
  scanCompositionManifestRefs,
  scanReorderItemRefs,
} from "./config-refs";
import { scanCssRefs, scanMarkdownRefs } from "./relative-refs";
import {
  scanAsPluginIdRefs,
  scanCompositionSourceRefs,
  scanPathRefs,
  scanRuntimeExceptionRefs,
} from "./ts-refs";
import type { PluginRef, PluginRefKind } from "./types";

/** The compositions manifest: its config lives under the owning plugin's slash path. */
export const COMPOSITIONS_MANIFEST = `config/${asPath(asPluginId("plugin-meta.composition"))}/compositions.origin.jsonc`;

/** The compositions manifest's SOURCE: the `defineConfig` seeds its origin is
 *  generated from. A move rewrites the ids here — the origin follows on build. */
export const COMPOSITIONS_SOURCE =
  "plugins/plugin-meta/plugins/composition/core/config.ts";

/** The boundary config whose `runtimeExceptions` name plugins. */
export const BOUNDARY_CONFIG =
  "plugins/framework/plugins/tooling/plugins/boundaries/core/boundary-config.ts";

export interface FindPluginRefsOptions {
  /** Only these kinds (default: all three). */
  kinds?: readonly PluginRefKind[];
}

const READ_WINDOW = 256;

const isTs = (p: string) => p.endsWith(".ts") || p.endsWith(".tsx");

async function readOrThrow(repo: RepoFiles, path: string): Promise<string> {
  const text = await repo.read(path);
  if (text == null)
    throw new Error(`plugin-refs: ${path} is not in the repo file set`);
  return text;
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
  options: FindPluginRefsOptions = {},
): Promise<PluginRef[]> {
  const kinds = new Set<PluginRefKind>(
    options.kinds ?? ["path", "dot", "relative"],
  );
  const slice = createTimeSlicer();
  const jobs: Array<{
    path: string;
    scanners: Array<(text: string) => PluginRef[]>;
  }> = [];
  for (const path of repo.all()) {
    const scanners: Array<(text: string) => PluginRef[]> = [];
    if (isTs(path) && !path.endsWith(".generated.ts")) {
      if (kinds.has("path")) scanners.push((t) => scanPathRefs(path, t));
      if (kinds.has("dot") && !isTestCodePath(path.split("/"))) {
        scanners.push((t) => scanAsPluginIdRefs(path, t));
      }
      if (kinds.has("dot") && path === BOUNDARY_CONFIG) {
        scanners.push((t) => scanRuntimeExceptionRefs(path, t));
      }
      if (kinds.has("dot") && path === COMPOSITIONS_SOURCE) {
        scanners.push((t) => scanCompositionSourceRefs(path, t));
      }
    } else if (
      kinds.has("dot") &&
      path.startsWith("config/") &&
      path.endsWith(".jsonc")
    ) {
      if (path === COMPOSITIONS_MANIFEST) {
        scanners.push((t) => scanCompositionManifestRefs(path, t));
      }
      scanners.push((t) => scanReorderItemRefs(path, t));
    } else if (kinds.has("relative") && path.endsWith(".md")) {
      scanners.push((t) => scanMarkdownRefs(path, t));
    } else if (kinds.has("relative") && path.endsWith(".css")) {
      scanners.push((t) => scanCssRefs(path, t));
    }
    if (scanners.length > 0) jobs.push({ path, scanners });
  }
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

  // Read a window at a time (the set's own gate bounds the open files; the
  // window bounds how many texts are held at once), scan in path order.
  const out: PluginRef[] = [];
  for (let i = 0; i < jobs.length; i += READ_WINDOW) {
    const window = jobs.slice(i, i + READ_WINDOW);
    const texts = await Promise.all(
      window.map((j) => readOrThrow(repo, j.path)),
    );
    for (let k = 0; k < window.length; k++) {
      await slice();
      for (const scanner of window[k]!.scanners)
        out.push(...scanner(texts[k]!));
    }
  }
  return out;
}
