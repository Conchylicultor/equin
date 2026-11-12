import {
  asPath,
  asPluginId,
  isTestCodePath,
} from "@plugins/framework/plugins/plugin-id/core";
import type { FileScan } from "@plugins/plugin-meta/plugins/plugin-records/core";
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

// `findPluginRefs`' per-file scan (`find.ts`). A scan's records are keyed by
// its module's whole closure (`FileScan.url`), so this module holds the scan
// and the code it runs, and nothing else.

/** The compositions manifest: its config lives under the owning plugin's slash path. */
export const COMPOSITIONS_MANIFEST = `config/${asPath(asPluginId("plugin-meta.composition"))}/compositions.origin.jsonc`;

/** The compositions manifest's SOURCE: the `defineConfig` seeds its origin is
 *  generated from. A move rewrites the ids here — the origin follows on build. */
export const COMPOSITIONS_SOURCE =
  "plugins/plugin-meta/plugins/composition/core/config.ts";

/** The boundary config whose `runtimeExceptions` name plugins. */
export const BOUNDARY_CONFIG =
  "plugins/framework/plugins/tooling/plugins/boundaries/core/boundary-config.ts";

const isTs = (p: string) => p.endsWith(".ts") || p.endsWith(".tsx");

/** The scanners that read `path` for `kinds` (none: the file names no plugin of those kinds). */
export function scannersFor(
  path: string,
  kinds: ReadonlySet<PluginRefKind>,
): Array<(text: string) => PluginRef[]> {
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
  return scanners;
}

/** Every kind: what the one file scan reads each file for. */
const ALL_REF_KINDS: ReadonlySet<PluginRefKind> = new Set([
  "path",
  "dot",
  "relative",
]);

/**
 * Every ref in one file, of every kind, as a file scan — one scan whatever
 * kinds a caller asks for (`findPluginRefs` filters after).
 *
 * Not one scan per kind set: a scan's parameters are part of every record's
 * key, so the three kind sets the passes ask for (`dot`, `path`+`dot`,
 * `relative`) kept three records of each file — a third of the shared store's
 * file records (measured 2026-11-12: 36k of 112k keys per scan identity), all
 * re-keyed together on every move of this module's closure. A file's refs of
 * kind K are the same whichever other kinds are read with them, so the
 * all-kinds value, filtered, IS each caller's answer.
 */
export const pluginRefsScan: FileScan<PluginRef[]> = {
  url: import.meta.url,
  scan: (text, path) =>
    scannersFor(path, ALL_REF_KINDS).flatMap((scanner) => scanner(text)),
};
