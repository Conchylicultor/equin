import {
  globPaths,
  type RepoSnapshot,
} from "@plugins/framework/plugins/tooling/core";
import { gitBlobId } from "../internal/keys";

/**
 * `base` (normally the real checkout, `loadRepoSnapshot(REPO_ROOT)`) with
 * `files` laid over it: each fixture path a member, its text its bytes, its
 * blob id the id of that text — so a record keyed by it moves exactly when the
 * fixture's text does. The real checkout stays underneath because a scan's or
 * fold's records are keyed by its own module's closure, which must be members
 * of the set.
 */
export function overlaySnapshot(
  base: RepoSnapshot,
  files: Readonly<Record<string, string>>,
): RepoSnapshot {
  const own = (p: string): boolean => Object.hasOwn(files, p);
  const paths = [...new Set([...base.all(), ...Object.keys(files)])].sort();
  return {
    root: base.root,
    all: () => paths,
    has: (p) => own(p) || base.has(p),
    under: (dir) =>
      dir === "" ? paths : paths.filter((p) => p.startsWith(`${dir}/`)),
    glob: (pattern) => globPaths(paths, pattern),
    read: (p) => (own(p) ? Promise.resolve(files[p]!) : base.read(p)),
    blobOf: (p) => (own(p) ? gitBlobId(files[p]!) : base.blobOf(p)),
  };
}
