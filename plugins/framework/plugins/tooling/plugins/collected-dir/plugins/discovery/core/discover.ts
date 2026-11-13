import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { resolve } from "path";
import type { FsSnapshot } from "@plugins/plugin-meta/plugins/parse-utils/core";
import { foldRepoFiles } from "@plugins/plugin-meta/plugins/plugin-records/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import type { CollectedDirDef } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import { PLUGIN_FOLDERS } from "@plugins/framework/plugins/plugin-id/core";
import {
  collectedDirMarkersIn,
  collectedDirsFold,
  type CollectedDirMarker,
} from "./collected-dirs.scan";

export interface DiscoveredCollectedDir extends CollectedDirDef {
  ownerDir: AppPath;
}

// ── Collected-dir discovery ────────────────────────────────────────
//
// A collected dir is declared by a `defineCollectedDir("<dir>")` call in a file
// directly under a plugin's `core/` — a `core/` that has a barrel. The
// candidates come from the repo's FILE SET (git's tracked + untracked-not-
// ignored, the universe the check cache key covers), never from a directory
// walk. The walk this replaced made ~2,600 blocking readdir/exists calls per
// call, four checks called it in one pass, and under a check pass's background
// priority that held the shared check thread for 16–40 s. It also saw
// gitignored directories, which no verdict may depend on.
//
// One pure core, two fronts that differ only in where the file list and the
// text come from:
//   - `discoverCollectedDirsIn(repo)` — the caller's file set: a check's run
//     set, codegen's pass set (a `RegistryGenContext`), a command's listing.
//   - `standardPluginDirsFromSnapshot(root, fs)` — the structure facet, over the
//     in-memory snapshot its own tree build already read. No disk at all.

// A file directly under a plugin's `core/`, at a plugin position: a top-level
// plugin directory, or a sub-plugin nested under `plugins/`, at most ten names
// deep (where the plugin-tree walk stops). Group 1 is the plugin's path under
// `plugins/`.
const CORE_FILE_RE =
  /^plugins\/([^/]+(?:\/plugins\/[^/]+){0,9})\/core\/[^/]+\.ts$/;

// A test file never declares a collected dir. Without this, a unit test that
// calls `defineCollectedDir("x")` for real would register a phantom runtime
// folder — a registry, a tsconfig-coverage demand, a "standard" folder name.
// (It also keeps every front agreeing: the facet's snapshot holds no tests.)
const TEST_FILE_RE = /\.test\.ts$/;

interface CollectedDirCandidate {
  /** Repo-relative path of the `core/*.ts` file. */
  rel: string;
  /** The owning plugin's path under `plugins/`. */
  pluginPath: string;
}

/** The `core/*.ts` files among `files` that can declare a collected dir. */
function collectedDirCandidates(
  files: Iterable<string>,
  has: (rel: string) => boolean,
): CollectedDirCandidate[] {
  const out: CollectedDirCandidate[] = [];
  for (const rel of files) {
    const m = CORE_FILE_RE.exec(rel);
    if (!m || TEST_FILE_RE.test(rel)) continue;
    const pluginPath = m[1]!;
    if (has(`plugins/${pluginPath}/core/index.ts`))
      out.push({ rel, pluginPath });
  }
  return out;
}

/**
 * The collected dirs `markers` declare, each owned by the plugin whose `core/`
 * holds its file, ordered by file path (each file's in call order) — the
 * order of the set's own listing, whatever order the markers were gathered in.
 */
function collectedDirsFrom(
  root: AppPath,
  markers: readonly CollectedDirMarker[],
): DiscoveredCollectedDir[] {
  const pluginsRoot = joinAppPath(root, "plugins");
  return [...markers]
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((m) => ({
      dir: m.dir,
      membership: m.membership,
      _brand: "CollectedDirDef" as const,
      ownerDir: joinAppPath(pluginsRoot, CORE_FILE_RE.exec(m.rel)![1]!),
    }));
}

/**
 * Every collected dir the tree declares, from the run's file set: no directory
 * walk, and each candidate's markers a plugin record (`collectedDirsFold`), so
 * a pass reads only the candidates whose bytes it has not folded yet — the
 * five checks and the codegen step that ask each read nothing after an edit
 * that touched no `core/*.ts`.
 */
export async function discoverCollectedDirsIn(
  repo: RepoFiles,
): Promise<DiscoveredCollectedDir[]> {
  const candidates = collectedDirCandidates(repo.under("plugins"), (rel) =>
    repo.has(rel),
  );
  const markers = await foldRepoFiles(
    repo,
    candidates.map((c) => c.rel),
    collectedDirsFold,
    null,
  );
  return collectedDirsFrom(repo.root, markers);
}

// ── Standard plugin folders ────────────────────────────────────────

// The set of directory names considered "standard" inside a plugin: the
// plugin-folder vocabulary (`PLUGIN_FOLDERS`, owned by plugin-id/core) plus
// `plugins/`, which holds child plugins rather than code. Discovered collected
// dirs do not widen it — discovery throws on a name outside the vocabulary —
// so the fronts below still run discovery: an undeclared collected dir fails
// every reader of this set, not only codegen.
const STANDARD_DIRS: ReadonlySet<string> = new Set([
  ...PLUGIN_FOLDERS,
  "plugins",
]);

/** The standard plugin folder names, from the run's file set. */
export async function standardPluginDirsIn(
  repo: RepoFiles,
): Promise<Set<string>> {
  await discoverCollectedDirsIn(repo); // throws on an undeclared name
  return new Set(STANDARD_DIRS);
}

// One answer per snapshot: a snapshot is one tree build's frozen read of the
// source, so the answer lives exactly as long as the snapshot does.
const snapshotStandardDirs = new WeakMap<FsSnapshot, Set<string>>();

/**
 * The standard plugin folder names, answered from a plugin-tree build's
 * in-memory FS snapshot — for the structure facet, whose `extract` is
 * synchronous and runs inside that build. The snapshot already holds every
 * plugin's non-test `core/*.ts`, so this touches no disk. `root` is the repo
 * root whose `plugins/` the snapshot covers.
 */
export function standardPluginDirsFromSnapshot(
  root: AppPath,
  fs: FsSnapshot,
): Set<string> {
  const cached = snapshotStandardDirs.get(fs);
  if (cached !== undefined) return cached;
  const prefix = `${resolve(root)}/`;
  const texts = new Map<string, string>();
  for (const [abs, text] of fs.files) {
    if (abs.startsWith(prefix)) texts.set(abs.slice(prefix.length), text);
  }
  const candidates = collectedDirCandidates(texts.keys(), (rel) =>
    texts.has(rel),
  );
  // Throws on an undeclared name.
  for (const c of candidates) collectedDirMarkersIn(c.rel, texts.get(c.rel)!);
  const std = new Set(STANDARD_DIRS);
  snapshotStandardDirs.set(fs, std);
  return std;
}
