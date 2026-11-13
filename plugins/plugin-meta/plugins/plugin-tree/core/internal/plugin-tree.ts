import { basename, join, relative } from "path";
import type { RepoFiles } from "@plugins/framework/plugins/tooling/core";
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
 * faceted-tree worker's deltas (`plugin-tree/faceted`), never built
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
 * The plugin positions a file supports, as paths under the plugins root
 * (`apps`, `apps/plugins/home`) — every directory along `relUnderRoot` that
 * sits at a plugin position and from which no non-walkable directory leads
 * down to the file.
 *
 * Purely positional: each directory directly under the plugins root, and each
 * directory directly under a plugin's `plugins/`, sits at a plugin position. It
 * is a plugin when it holds source content: at least one file of the set
 * somewhere under it, not inside `node_modules` or a dot-dir — i.e. when at
 * least one file supports it.
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
export function pluginPositionsOf(relUnderRoot: string): string[] {
  const segs = relUnderRoot.split("/");
  const dirCount = segs.length - 1; // the last segment is the file
  const positions: string[] = [];
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
    if (walkable) positions.push(segs.slice(0, k + 1).join("/"));
    if (segs[k + 1] !== "plugins" || k + 2 >= dirCount) break;
    k += 2;
  }
  return positions;
}

/** Every plugin directory (relative to `pluginsRoot`), read off the repo's file set — no `readdir`. */
export function findAllPluginDirs(
  pluginsRoot: AppPath,
  repo: RepoFiles,
): string[] {
  const rel = relative(repo.root, pluginsRoot);
  const found = new Set<string>();
  for (const path of repo.under(rel)) {
    for (const p of pluginPositionsOf(path.slice(rel.length + 1))) found.add(p);
  }
  return [...found];
}

// ── Per-plugin collection ───────────────────────────────────────────

/**
 * What a plugin's node says about it, read from its own key files (the
 * {@link PLUGIN_KEY_FILES}) and nothing else — so a node is re-read exactly
 * when one of them is added, removed or edited.
 */
export interface PluginFields {
  description?: string;
  descriptions: Partial<Record<Runtime, string>>;
  loadBearing: boolean;
  collapsed: boolean;
  compositionRoot: boolean;
  runtimes: Record<Runtime, boolean>;
}

const RUNTIME_BARRELS = {
  web: "web/index.ts",
  server: "server/index.ts",
  machine: "machine/index.ts",
  central: "central/index.ts",
} as const satisfies Record<Runtime, string>;

/** The files, relative to a plugin's folder, its {@link PluginFields} are read from. */
export const PLUGIN_KEY_FILES: readonly string[] = [
  ...Object.values(RUNTIME_BARRELS),
  "package.json",
];

/**
 * The plugin a key file belongs to (its path under the plugins root), when
 * `relUnderRoot` is one of {@link PLUGIN_KEY_FILES} of the folder it sits in —
 * null for any other file. Positional only: whether that folder IS a plugin is
 * the caller's question ({@link pluginPositionsOf}).
 */
export function keyFileOwner(relUnderRoot: string): string | null {
  for (const key of PLUGIN_KEY_FILES) {
    if (relUnderRoot.endsWith(`/${key}`)) {
      return relUnderRoot.slice(0, relUnderRoot.length - key.length - 1);
    }
  }
  return null;
}

/**
 * What one key file says, parsed from its text alone: a runtime barrel's own
 * `export default { … }` fields, or a `package.json`'s description and plugin
 * flags. A function of the file's bytes and which key file it is — nothing
 * else — so a reader holding records per file (`plugin-tree/structure-records`)
 * parses only the key files an edit touched. `null` for an empty file, which
 * counts as absent (no runtime, no fields), as it always has.
 */
export type KeyFileFacts =
  | { kind: "barrel"; meta: BarrelMeta }
  | {
      kind: "package";
      description?: string;
      collapsed: boolean;
      compositionRoot: boolean;
    };

/**
 * Parse one key file. `keyFile` is its path relative to the plugin's folder
 * (one of {@link PLUGIN_KEY_FILES}); `file` names it in an error. Throws when a
 * barrel's fields cannot be read (`parsePluginBarrel`).
 */
export function parseKeyFile(
  keyFile: string,
  text: string,
  file: string,
): KeyFileFacts | null {
  if (!text) return null;
  if (keyFile !== "package.json") {
    return { kind: "barrel", meta: parsePluginBarrel(text, file) };
  }
  let description: string | undefined;
  let collapsed = false;
  let compositionRoot = false;
  try {
    const pkg = JSON.parse(text);
    if (typeof pkg.description === "string" && pkg.description)
      description = pkg.description;
    const own = pkg[PLUGIN_MANIFEST_KEY];
    if (own?.collapsed === true) collapsed = true;
    if (own?.compositionRoot === true) compositionRoot = true;
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch {}
  return {
    kind: "package",
    ...(description === undefined ? {} : { description }),
    collapsed,
    compositionRoot,
  };
}

function barrelMeta(facts: KeyFileFacts | null): BarrelMeta | null {
  return facts?.kind === "barrel" ? facts.meta : null;
}

/**
 * A plugin's {@link PluginFields} from its key files' facts, handed in
 * {@link PLUGIN_KEY_FILES} order (`null` for a key file it does not have).
 */
export function pluginFieldsFrom(
  facts: readonly (KeyFileFacts | null)[],
): PluginFields {
  const [web, server, machine, central, pkg] = facts;
  const webMeta = barrelMeta(web ?? null);
  const serverMeta = barrelMeta(server ?? null);
  const machineMeta = barrelMeta(machine ?? null);
  const centralMeta = barrelMeta(central ?? null);
  const pkgFacts = pkg?.kind === "package" ? pkg : null;

  const descriptions: Partial<Record<Runtime, string>> = {};
  if (webMeta?.description) descriptions.web = webMeta.description;
  if (serverMeta?.description) descriptions.server = serverMeta.description;
  if (machineMeta?.description) descriptions.machine = machineMeta.description;
  if (centralMeta?.description) descriptions.central = centralMeta.description;
  let description =
    webMeta?.description ??
    serverMeta?.description ??
    machineMeta?.description ??
    centralMeta?.description;
  if (!description && pkgFacts?.description) description = pkgFacts.description;

  const metas = [webMeta, serverMeta, machineMeta, centralMeta];
  return {
    description,
    descriptions,
    loadBearing: metas.some((m) => m?.loadBearing ?? false),
    collapsed:
      metas.some((m) => m?.collapsed ?? false) ||
      (pkgFacts?.collapsed ?? false),
    compositionRoot: pkgFacts?.compositionRoot ?? false,
    runtimes: {
      web: webMeta !== null,
      server: serverMeta !== null,
      machine: machineMeta !== null,
      central: centralMeta !== null,
    },
  };
}

/**
 * Read a plugin's {@link PluginFields}. `read` answers a key file's text by its
 * path relative to the plugin's folder, or null when it is not in the set.
 */
export async function collectPluginFields(
  dir: AppPath,
  read: (keyFile: string) => Promise<string | null>,
): Promise<PluginFields> {
  const texts = await Promise.all(PLUGIN_KEY_FILES.map(read));
  return pluginFieldsFrom(
    PLUGIN_KEY_FILES.map((keyFile, i) =>
      parseKeyFile(keyFile, texts[i] ?? "", join(dir, keyFile)),
    ),
  );
}

// ── Tree assembly ───────────────────────────────────────────────────

function computeIds(nodes: PluginNode[], parentId: string): void {
  for (const node of nodes) {
    node.id = asPluginId(parentId ? `${parentId}.${node.name}` : node.name);
    computeIds(node.children, node.id);
  }
}

/**
 * Link plugins into a tree: each node under its nearest plugin ancestor,
 * siblings by name, hierarchy ids computed. Pure and in memory — `plugins`
 * maps each plugin's path under `pluginsRoot` to its fields, in any order.
 */
export function assemblePluginTree(
  pluginsRoot: AppPath,
  plugins: Iterable<readonly [string, PluginFields]>,
): PluginTreeData {
  const byDir = new Map<string, PluginNode>();
  const byPath = new Map<string, PluginNode>();
  const sorted = [...plugins].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, fields] of sorted) {
    const dir = joinAppPath(pluginsRoot, ...path.split("/"));
    const node: PluginNode = {
      dir,
      path,
      name: basename(dir),
      id: asPluginId(""),
      description: fields.description,
      descriptions: { ...fields.descriptions },
      loadBearing: fields.loadBearing,
      collapsed: fields.collapsed,
      compositionRoot: fields.compositionRoot,
      runtimes: { ...fields.runtimes },
      children: [],
      facets: {},
    };
    byDir.set(dir, node);
    byPath.set(path, node);
  }

  // Parent resolution: the nearest `<…>/plugins/<name>` ancestor that is a plugin.
  const roots: PluginNode[] = [];
  for (const node of byPath.values()) {
    let segs = node.path.split("/");
    let parent: PluginNode | undefined;
    while (
      !parent &&
      segs.length >= 3 &&
      segs[segs.length - 2] === NESTING_SEGMENT
    ) {
      segs = segs.slice(0, segs.length - 2);
      parent = byPath.get(segs.join("/"));
    }
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortRec = (list: PluginNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const c of list) sortRec(c.children);
  };
  sortRec(roots);

  computeIds(roots, "");

  return { pluginsRoot, byDir, byPath, roots };
}

export interface BuildPluginTreeOptions {
  /**
   * The pass's file set (a build's snapshot, a check run's `ctx.repo()`) — the
   * tree is read off it and nothing else lists the repo. Required: a tree that
   * listed the repo itself was one more whole-tree `git ls-files` per caller.
   * The faceted build (`plugin-tree/faceted`) passes a SNAPSHOT, whose blob ids
   * key its facet records.
   */
  repo: RepoFiles;
}

/**
 * The plugin tree under `pluginsRoot`, read off `opts.repo` — the pass's file
 * set, whose root `pluginsRoot` sits directly under. Nothing here walks the
 * disk or lists the repo.
 */
export async function buildPluginTree(
  pluginsRoot: AppPath,
  opts: BuildPluginTreeOptions,
): Promise<PluginTree> {
  const { repo } = opts;
  if (repo.root !== appPathParent(pluginsRoot)) {
    throw new Error(
      `buildPluginTree(${pluginsRoot}): the repo set is of ${repo.root}, not of the plugins root's parent.`,
    );
  }
  const rootRel = relative(repo.root, pluginsRoot);
  const plugins = await Promise.all(
    findAllPluginDirs(pluginsRoot, repo).map(
      async (path) =>
        [
          path,
          await collectPluginFields(
            joinAppPath(pluginsRoot, ...path.split("/")),
            (keyFile) => repo.read(`${rootRel}/${path}/${keyFile}`),
          ),
        ] as const,
    ),
  );
  return { ...assemblePluginTree(pluginsRoot, plugins), repo, facets: [] };
}
