// The rules both providers apply the same way, in one place — so the desktop
// and a browser host cannot disagree on what a watcher reports or which writes
// are refused.

import { relName, type RelPath } from "../../core";
import type { FileRootSpec } from "./service";

/**
 * The changed paths a root's watch reports: those whose name ends in one of the
 * root's `watch.extensions` (all of them when it declares none).
 */
export function watchedPaths(
  spec: FileRootSpec,
  paths: Iterable<RelPath>,
): RelPath[] {
  const extensions = spec.watch?.extensions;
  const out: RelPath[] = [];
  for (const path of paths) {
    if (path === "") continue;
    if (
      extensions === undefined ||
      extensions.some((ext) => relName(path).endsWith(ext))
    ) {
      out.push(path);
    }
  }
  return out;
}

/** The watch policy of a root, or a throw naming what to declare. */
export function requireWatchSpec(
  spec: FileRootSpec,
): NonNullable<FileRootSpec["watch"]> {
  if (spec.watch === undefined) {
    throw new Error(
      `[data-files] root "${spec.id}" is watched but declares no \`watch\` — add one to its defineFileRoot`,
    );
  }
  return spec.watch;
}

/** A mutation of the root itself is never meant: its owner's data dir is not a file. */
export function assertNotRoot(
  spec: FileRootSpec,
  path: RelPath,
  operation: string,
): void {
  if (path === "") {
    throw new Error(
      `[data-files] ${operation} of the root of "${spec.id}" itself — name a path inside it`,
    );
  }
}
