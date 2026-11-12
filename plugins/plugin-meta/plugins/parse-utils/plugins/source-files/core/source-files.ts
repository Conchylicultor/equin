import {
  existsSync,
  readdirSync,
  readFileSync,
} from "@plugins/packages/plugins/timed-fs/core";
import { dirname, join, relative } from "path";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import {
  TESTING_FOLDER,
  TESTS_DIR,
  isTestCodePath,
} from "@plugins/framework/plugins/plugin-id/core";
import {
  assertDiskReadAllowed,
  currentFsSnapshot,
  snapshotHas,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

export function readIfExistsSync(path: AppPath): string | null {
  const snapshot = currentFsSnapshot();
  if (snapshot) {
    const cached = snapshot.files.get(path);
    if (cached !== undefined) return cached;
    // The directory was scanned but the file is absent → definitively null, no
    // syscall. Otherwise the directory is outside the snapshot's scope → disk.
    if (snapshot.dirs.has(dirname(path))) return null;
    if (snapshotHas(path) === false) return null;
    assertDiskReadAllowed(path);
  }
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * `existsSync` for a scanner: answered from the ambient snapshot when it
 * covers `path` (or the directory holding it), from disk otherwise — so a facet
 * asking "has this plugin a `web/`?" for every plugin costs no syscall.
 */
export function pathExistsSync(path: AppPath): boolean {
  const known = snapshotHas(path);
  if (known !== undefined) return known;
  assertDiskReadAllowed(path);
  return existsSync(path);
}

function isSkippedWalkDir(name: string): boolean {
  // `plugins` = sub-plugin trees (scanned as their own plugins); `__tests__`
  // and `testing` = test code (`isTestCodePath`), which is not part of a
  // plugin's API/dep surface and must not pollute its facets (Uses, exports,
  // routes, …). `testing/` matters beyond docs: the cross-refs facet feeds the
  // composition closure, so a harness's imports (build tooling, fixtures)
  // would otherwise become shipped edges. The name is reserved — boundary-rules
  // reports a `testing/` anywhere but directly under a runtime folder — so
  // skipping it by name alone is exact.
  return (
    name === "node_modules" ||
    name === "plugins" ||
    name === TESTS_DIR ||
    name === TESTING_FOLDER
  );
}

// A plugin's API/dep surface excludes co-located bun:test files (`*.test.ts(x)`,
// which the convention co-locates next to source rather than under `__tests__`) —
// the same rationale as the `__tests__` dir skip. Since `walkFilesSync` is the shared
// source-file enumerator for every facet + codegen scan, excluding them here keeps
// a test fixture (e.g. a `liveValue("mismatch-test", …)` in a
// `*.test.ts`) or a test-only import from leaking into a plugin's docs.
function isSourceFile(name: string, css: boolean): boolean {
  return (
    (/\.(ts|tsx)$/.test(name) || (css && name.endsWith(".css"))) &&
    !isTestCodePath([name])
  );
}

/**
 * Every source file under `dir` (sub-plugin trees and test code skipped):
 * `.ts`/`.tsx`, plus `.css` with `{ css: true }` — for a scanner that reads
 * what a plugin styles with, not only what it imports.
 */
export function walkFilesSync(
  dir: AppPath,
  out: AppPath[],
  opts?: { css?: boolean },
): void {
  const css = opts?.css ?? false;
  // Snapshot fast-path: traverse the in-memory directory map. Any subdirectory
  // not covered by the snapshot re-dispatches through `walkFilesSync`, which falls
  // back to disk for that subtree — so the result is identical to a pure-disk
  // walk regardless of snapshot coverage.
  const snapshot = currentFsSnapshot();
  if (snapshot) {
    const entries = snapshot.dirs.get(dir);
    // A dir the snapshot knows is absent (its parent was scanned, it is not
    // there) holds no files — no `readdirSync` to find out.
    if (!entries && snapshotHas(dir) === false) return;
    if (entries) {
      for (const e of entries) {
        const p = joinAppPath(dir, e.name);
        if (e.isDirectory()) {
          if (isSkippedWalkDir(e.name)) continue;
          walkFilesSync(p, out, opts);
        } else if (e.isFile() && isSourceFile(e.name, css)) {
          out.push(p);
        }
      }
      return;
    }
    // dir not in snapshot → fall through to disk below.
    assertDiskReadAllowed(dir);
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code == null) throw err;
    return;
  }
  for (const e of entries) {
    const p = joinAppPath(dir, e.name);
    if (e.isDirectory()) {
      if (isSkippedWalkDir(e.name)) continue;
      walkFilesSync(p, out, opts);
    } else if (e.isFile() && isSourceFile(e.name, css)) {
      out.push(p);
    }
  }
}

/**
 * {@link walkFilesSync}' answer read off a repo's file set instead of the disk: the
 * source files under `dir` (absolute) — same skipped directories, same
 * test-file exclusion — with no syscall. Membership is git's, so a gitignored
 * file under `dir` is not among them. For a scan over many plugins (a codegen
 * collector, a check pass), which the tree it walks already holds the set for
 * (`PluginTree.repo`).
 */
export function sourceFilesIn(repo: RepoFiles, dir: string): string[] {
  const rel = relative(repo.root, dir);
  const out: string[] = [];
  for (const path of repo.under(rel)) {
    const segs = path.slice(rel.length + 1).split("/");
    const name = segs[segs.length - 1]!;
    if (!isSourceFile(name, false)) continue;
    let skipped = false;
    for (let i = 0; i < segs.length - 1; i++) {
      if (isSkippedWalkDir(segs[i]!)) {
        skipped = true;
        break;
      }
    }
    if (!skipped) out.push(join(repo.root, path));
  }
  return out;
}
