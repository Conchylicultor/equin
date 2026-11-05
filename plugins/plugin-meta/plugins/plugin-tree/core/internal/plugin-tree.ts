import { basename, join, relative } from "path";
import {
  loadRepoFiles,
  type RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import type { Facet } from "@plugins/plugin-meta/plugins/facets/core";
import {
  asPluginId,
  type PluginId,
  PLUGIN_MANIFEST_KEY,
} from "@plugins/framework/plugins/plugin-id/core";
import { parsePluginBarrel, type BarrelMeta } from "./barrel-meta";
import {
  appPathParent,
  type AppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";

// ── Public types ────────────────────────────────────────────────────

export type Runtime = "web" | "server" | "machine" | "central";

export interface PluginNode {
  dir: AppPath;
  path: string;
  name: string;
  id: PluginId;
  description?: string;
  descriptions: Partial<Record<Runtime, string>>;
  loadBearing: boolean;
  collapsed: boolean;
  compositionRoot: boolean;
  runtimes: Record<Runtime, boolean>;
  children: PluginNode[];
  facets: Record<string, unknown>;
}

/**
 * A plugin tree as data: the nodes (each with whatever facet data it carries)
 * and their indexes — what a consumer that only READS facet data needs. The
 * serving backend holds the faceted tree in this form, read off the
 * `plugin-tree-facets` command's output (`plugin-tree/faceted`), never built
 * in-process: building it runs the facet extractors, which are build tooling.
 */
export interface PluginTreeData {
  pluginsRoot: AppPath;
  byDir: Map<string, PluginNode>;
  byPath: Map<string, PluginNode>;
  roots: PluginNode[];
}

export interface PluginTree extends PluginTreeData {
  /**
   * The repo file set the tree was read off — what a consumer scanning plugin
   * files lists them from (`sourceFilesIn`), so a scan never walks the disk
   * and always agrees with the tree on which files exist.
   */
  repo: RepoFiles;
  /**
   * The facet extractors whose data the nodes carry: empty on a structure
   * tree, filled by the faceted build (`plugin-tree/faceted`).
   */
  facets: Facet[];
}

const NESTING_SEGMENT = "plugins"; // umbrella interstitial; asFsPath joins ids with "/plugins/"

/**
 * Resolve a cross-plugin module specifier (`@plugins/<path>/<barrel>[/...]`) to its
 * unique plugin node via longest-prefix match against the real plugin-path registry.
 * Needs no runtime vocabulary: whatever exists in `byPath` is a plugin; the trailing
 * segments are the barrel suffix (any name). Returns null for a non-@plugins specifier,
 * an unknown plugin, or a specifier that nests deeper than any real plugin (next
 * segment is the literal "plugins") — callers treat the latter two as broken refs.
 */
export function resolvePluginSpecifier(
  tree: PluginTreeData,
  specifier: string,
): { node: PluginNode; suffix: string[] } | null {
  if (!specifier.startsWith("@plugins/")) return null;
  const parts = specifier.slice("@plugins/".length).split("/");
  let best: PluginNode | undefined;
  let bestLen = 0;
  for (let i = 1; i <= parts.length; i++) {
    const node = tree.byPath.get(parts.slice(0, i).join("/"));
    if (node && i > bestLen) {
      best = node;
      bestLen = i;
    }
  }
  if (!best) return null;
  const suffix = parts.slice(bestLen);
  if (suffix[0] === NESTING_SEGMENT) return null;
  return { node: best, suffix };
}

// ── Discovery ───────────────────────────────────────────────────────

// Non-source noise skipped at every plugin position: node_modules and dot-dirs.
// This is a stable denylist that never grows — unlike the old content gate, every
// other directory at a plugin position is a plugin, irrespective of its contents.
function isWalkable(name: string): boolean {
  return name !== "node_modules" && !name.startsWith(".");
}

// How deep plugin positions nest (a top-level plugin is depth 1).
const MAX_DEPTH = 10;

/**
 * Every plugin directory, read off the repo's file set — no `readdir`.
 *
 * Purely positional: each directory directly under `pluginsRoot`, and each
 * directory directly under a plugin's `plugins/`, sits at a plugin position. It
 * is a plugin when it holds source content: at least one file of the set
 * somewhere under it, not inside `node_modules` or a dot-dir.
 *
 * The content gate guards against *hollow shells*: when a plugin is relocated,
 * `git mv` removes its tracked files but leaves behind the untracked
 * `node_modules/` directory git never tracked. Membership is git's, so such a
 * shell holds no file of the set and is no plugin — in a long-lived checkout
 * exactly as in a fresh worktree, which is what keeps discovery (and every
 * check/codegen step built on it) from diverging between the two: a branch that
 * passes `push` checks cannot break `main`'s build on a phantom plugin. A
 * freshly authored, not-yet-committed plugin is untracked-not-ignored, so it is
 * in the set and still found.
 */
function findAllPluginDirs(pluginsRoot: AppPath, repo: RepoFiles): AppPath[] {
  const rel = relative(repo.root, pluginsRoot);
  const found = new Set<string>();
  for (const path of repo.under(rel)) {
    const segs = path.slice(rel.length + 1).split("/");
    const dirCount = segs.length - 1; // the last segment is the file
    // `k` indexes a plugin position's own segment; `walkable` holds while every
    // directory from it down to the file is walkable.
    for (let k = 0, depth = 1; k < dirCount && depth <= MAX_DEPTH; depth++) {
      if (!isWalkable(segs[k]!)) break;
      let walkable = true;
      for (let i = k + 1; i < dirCount; i++) {
        if (!isWalkable(segs[i]!)) {
          walkable = false;
          break;
        }
      }
      if (walkable) found.add(segs.slice(0, k + 1).join("/"));
      if (segs[k + 1] !== "plugins" || k + 2 >= dirCount) break;
      k += 2;
    }
  }
  return [...found].map((d) => joinAppPath(pluginsRoot, ...d.split("/")));
}

// ── Per-plugin collection ───────────────────────────────────────────

interface CollectedPlugin {
  node: PluginNode;
  parentDir: AppPath | null;
}

async function collectCoreFields(
  dir: AppPath,
  pluginsRoot: AppPath,
  repo: RepoFiles,
): Promise<CollectedPlugin> {
  const dirRel = relative(repo.root, dir);
  const [webIndex, serverIndex, machineIndex, centralIndex, pkgSrc] =
    await Promise.all(
      [
        "web/index.ts",
        "server/index.ts",
        "machine/index.ts",
        "central/index.ts",
        "package.json",
      ].map((f) => repo.read(`${dirRel}/${f}`)),
    );

  // Read each runtime barrel's OWN default-exported object literal from ORIGINAL
  // source — never transpiler output, which re-quotes string literals and silently
  // dropped descriptions containing an escaped quote.
  const webMeta: BarrelMeta | null = webIndex
    ? parsePluginBarrel(webIndex, join(dir, "web", "index.ts"))
    : null;
  const serverMeta: BarrelMeta | null = serverIndex
    ? parsePluginBarrel(serverIndex, join(dir, "server", "index.ts"))
    : null;
  const machineMeta: BarrelMeta | null = machineIndex
    ? parsePluginBarrel(machineIndex, join(dir, "machine", "index.ts"))
    : null;
  const centralMeta: BarrelMeta | null = centralIndex
    ? parsePluginBarrel(centralIndex, join(dir, "central", "index.ts"))
    : null;

  const webDesc = webMeta?.description;
  const serverDesc = serverMeta?.description;
  const machineDesc = machineMeta?.description;
  const centralDesc = centralMeta?.description;
  const descriptions: Partial<Record<Runtime, string>> = {};
  if (webDesc) descriptions.web = webDesc;
  if (serverDesc) descriptions.server = serverDesc;
  if (machineDesc) descriptions.machine = machineDesc;
  if (centralDesc) descriptions.central = centralDesc;
  let description = webDesc ?? serverDesc ?? machineDesc ?? centralDesc;
  if (!description && pkgSrc) {
    try {
      const pkg = JSON.parse(pkgSrc);
      if (typeof pkg.description === "string" && pkg.description)
        description = pkg.description;
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {}
  }

  const loadBearing =
    (webMeta?.loadBearing ?? false) ||
    (serverMeta?.loadBearing ?? false) ||
    (machineMeta?.loadBearing ?? false) ||
    (centralMeta?.loadBearing ?? false);

  let collapsed =
    (webMeta?.collapsed ?? false) ||
    (serverMeta?.collapsed ?? false) ||
    (machineMeta?.collapsed ?? false) ||
    (centralMeta?.collapsed ?? false);
  // package.json collapsed and compositionRoot markers.
  let compositionRoot = false;
  if (pkgSrc) {
    try {
      const pkg = JSON.parse(pkgSrc);
      const own = pkg[PLUGIN_MANIFEST_KEY];
      if (own?.collapsed === true) collapsed = true;
      if (own?.compositionRoot === true) compositionRoot = true;
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {}
  }

  const rel = relative(pluginsRoot, dir);
  const segs = rel.split(/[\\/]+/);
  let parentDir: AppPath | null = null;
  if (segs.length >= 3 && segs[segs.length - 2] === "plugins") {
    parentDir = joinAppPath(pluginsRoot, ...segs.slice(0, segs.length - 2));
  }

  const path = rel.split("\\").join("/");

  return {
    parentDir,
    node: {
      dir,
      path,
      name: basename(dir),
      id: asPluginId(""),
      description,
      descriptions,
      loadBearing,
      collapsed,
      compositionRoot,
      runtimes: {
        web: !!webIndex,
        server: !!serverIndex,
        machine: !!machineIndex,
        central: !!centralIndex,
      },
      children: [],
      facets: {},
    },
  };
}

// ── Tree assembly ───────────────────────────────────────────────────

function computeIds(nodes: PluginNode[], parentId: string): void {
  for (const node of nodes) {
    node.id = asPluginId(parentId ? `${parentId}.${node.name}` : node.name);
    computeIds(node.children, node.id);
  }
}

export interface BuildPluginTreeOptions {
  /**
   * The repo's file set. Absent, the tree asks git for one. The faceted build
   * (`plugin-tree/faceted`) passes a SNAPSHOT, whose blob ids key its facet
   * records.
   */
  repo?: RepoFiles;
}

/**
 * The plugin tree under `pluginsRoot`, read off `opts.repo` — the repo's file
 * set, whose root `pluginsRoot` sits directly under. A caller that holds the
 * pass's set (a build's snapshot, a check run's `ctx.repo()`) passes it; with
 * none, the tree asks git for one. Nothing here walks the disk.
 */
export async function buildPluginTree(
  pluginsRoot: AppPath,
  opts?: BuildPluginTreeOptions,
): Promise<PluginTree> {
  const repo = opts?.repo ?? (await loadRepoFiles(appPathParent(pluginsRoot)));
  if (repo.root !== appPathParent(pluginsRoot)) {
    throw new Error(
      `buildPluginTree(${pluginsRoot}): the repo set is of ${repo.root}, not of the plugins root's parent.`,
    );
  }
  // Step 1: find all plugin directories, sorted for a deterministic order.
  const dirs = findAllPluginDirs(pluginsRoot, repo).sort();

  // Step 2: collect core fields for each plugin (async parallel reads)
  const byDir = new Map<string, PluginNode>();
  const byPath = new Map<string, PluginNode>();
  const parentDirs = new Map<string, AppPath | null>();

  const collected = await Promise.all(
    dirs.map((d) => collectCoreFields(d, pluginsRoot, repo)),
  );
  for (const c of collected) {
    byDir.set(c.node.dir, c.node);
    byPath.set(c.node.path, c.node);
    parentDirs.set(c.node.dir, c.parentDir);
  }

  // Step 3: assemble tree — parent resolution, children, sort, hierarchy IDs
  const roots: PluginNode[] = [];
  for (const [dir, node] of byDir) {
    let parent = parentDirs.get(dir) ?? null;
    while (parent && !byDir.has(parent)) {
      const rel = relative(pluginsRoot, parent);
      const segs = rel.split(/[\\/]+/);
      if (segs.length >= 3 && segs[segs.length - 2] === "plugins") {
        parent = joinAppPath(pluginsRoot, ...segs.slice(0, segs.length - 2));
      } else {
        parent = null;
      }
    }
    if (parent && byDir.has(parent)) {
      byDir.get(parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (list: PluginNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const c of list) sortRec(c.children);
  };
  sortRec(roots);

  computeIds(roots, "");

  return { pluginsRoot, repo, byDir, byPath, roots, facets: [] };
}
