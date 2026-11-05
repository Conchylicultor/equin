import {
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { resolve } from "path";
import {
  findMarkerCalls,
  type FsSnapshot,
} from "@plugins/plugin-meta/plugins/parse-utils/core";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
import type { CollectedDirDef } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import {
  PLUGIN_FOLDERS,
  type PluginFolder,
} from "@plugins/framework/plugins/plugin-id/core";

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

// First positional string argument of a `defineCollectedDir("<dir>")` call.
const FIRST_STRING_ARG_RE = /^\s*["']([^"']+)["']/;
// The optional second argument, `{ membership: "<m>" }`, spelled literally —
// anything else after the first argument throws (see `membershipOf`).
const MEMBERSHIP_ARG_RE =
  /^\s*,\s*\{\s*membership\s*:\s*["'](composition|checkout)["']\s*,?\s*\}\s*,?\s*$/;

/**
 * The membership the call's text declares. The marker is read by regex, so a
 * second argument this cannot read literally (an identifier, a spread) would
 * otherwise silently mean "composition" — it throws instead, naming the file.
 */
function membershipOf(
  rel: string,
  rest: string,
): CollectedDirDef["membership"] {
  if (rest.trim() === "" || rest.trim() === ",") return "composition";
  const m = MEMBERSHIP_ARG_RE.exec(rest);
  if (!m) {
    throw new Error(
      `${rel}: defineCollectedDir's second argument must be the literal \`{ membership: "composition" | "checkout" }\` — codegen reads the marker by its text. Got: ${rest.trim()}`,
    );
  }
  return m[1] as CollectedDirDef["membership"];
}

const PLUGIN_FOLDER_SET: ReadonlySet<string> = new Set(PLUGIN_FOLDERS);
const isPluginFolder = (name: string): name is PluginFolder =>
  PLUGIN_FOLDER_SET.has(name);

/**
 * The collected dirs the candidates' `text` declares. Pure. A declared name
 * that is not a `PluginFolder` throws naming the file: a collected dir is a
 * plugin folder, and a plugin folder needs its row in the boundary table. The
 * typed marker already makes that a tsc error; this covers the untyped copy.
 */
function collectedDirsFrom(
  root: AppPath,
  sources: Iterable<CollectedDirCandidate & { text: string }>,
): DiscoveredCollectedDir[] {
  const pluginsRoot = joinAppPath(root, "plugins");
  const out: DiscoveredCollectedDir[] = [];
  for (const { rel, pluginPath, text } of sources) {
    // Fast-path: skip files that can't contain the marker. Correctness still
    // comes from `findMarkerCalls`, which ignores comment/string/regex matches.
    if (!text.includes("defineCollectedDir")) continue;
    for (const call of findMarkerCalls(text, "defineCollectedDir")) {
      const arg = FIRST_STRING_ARG_RE.exec(call.argsText);
      if (!arg) continue;
      const dir = arg[1]!;
      if (!isPluginFolder(dir)) {
        throw new Error(
          `${rel} declares collected dir "${dir}", which is not a plugin folder. ` +
            `Declare it in LEAF_FOLDERS (plugin-id/core) and give it a row in the ` +
            `boundary table (boundaries/core/boundary-config.ts). Known folders: ` +
            `${PLUGIN_FOLDERS.join(", ")}.`,
        );
      }
      out.push({
        dir,
        membership: membershipOf(rel, call.argsText.slice(arg[0].length)),
        _brand: "CollectedDirDef",
        ownerDir: joinAppPath(pluginsRoot, pluginPath),
      });
    }
  }
  return out;
}

/**
 * The text of `rel`, taken from `repo`'s own listing: null here means the file
 * vanished after the set was listed — the tree changed under the run, and a
 * discovery over a tree that moved is not an answer about any tree. Throw.
 */
async function readListed(repo: RepoFiles, rel: string): Promise<string> {
  const text = await repo.read(rel);
  if (text === null) {
    throw new Error(
      `${rel} is in the repo's file set but could not be read — it was removed ` +
        `after the set was listed. Re-run once the working tree is stable.`,
    );
  }
  return text;
}

/**
 * Every collected dir the tree declares, from the run's file set: no directory
 * walk, and every read asynchronous (the set's reader bounds the opens).
 */
export async function discoverCollectedDirsIn(
  repo: RepoFiles,
): Promise<DiscoveredCollectedDir[]> {
  const candidates = collectedDirCandidates(repo.under("plugins"), (rel) =>
    repo.has(rel),
  );
  const sources = await Promise.all(
    candidates.map(async (c) => ({
      ...c,
      text: await readListed(repo, c.rel),
    })),
  );
  return collectedDirsFrom(repo.root, sources);
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
  collectedDirsFrom(
    root,
    candidates.map((c) => ({ ...c, text: texts.get(c.rel)! })),
  );
  const std = new Set(STANDARD_DIRS);
  snapshotStandardDirs.set(fs, std);
  return std;
}
