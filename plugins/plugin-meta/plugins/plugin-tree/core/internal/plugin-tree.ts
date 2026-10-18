import {
  declarePluginSlots,
  declaredSlotSources,
} from "@plugins/framework/plugins/slot-declaration/core";
import { existsSync } from "fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "path";
import {
  registerBarrelStubs,
  importBarrel,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  loadFacets,
  setFacet,
  type Facet,
} from "@plugins/plugin-meta/plugins/facets/core";
import {
  asPluginId,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { runWithFsSnapshot } from "@plugins/plugin-meta/plugins/parse-utils/core";
import {
  createTimeSlicer,
  yieldMacrotask,
} from "@plugins/packages/plugins/macrotask-yield/core";
import { buildFsSnapshot } from "./fs-snapshot";
import { parsePluginBarrel, type BarrelMeta } from "./barrel-meta";

async function readIfExistsAsync(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code == null) throw err;
    return null;
  }
}

// ── Public types ────────────────────────────────────────────────────

export type Runtime = "web" | "server" | "machine" | "central";

export interface PluginNode {
  dir: string;
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

export interface PluginTree {
  pluginsRoot: string;
  byDir: Map<string, PluginNode>;
  byPath: Map<string, PluginNode>;
  roots: PluginNode[];
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
  tree: PluginTree,
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

// ── Walk ────────────────────────────────────────────────────────────

// Non-source noise skipped at every plugin position: node_modules and dot-dirs.
// This is a stable denylist that never grows — unlike the old content gate, every
// other directory at a plugin position is a plugin, irrespective of its contents.
function isWalkable(name: string): boolean {
  return name !== "node_modules" && !name.startsWith(".");
}

/**
 * A directory at a plugin position is a real plugin only if it holds source
 * content — at least one regular file somewhere under it (excluding the
 * `node_modules`/dot-dir noise `isWalkable` already skips).
 *
 * This guards against *hollow shells*: when a plugin is relocated, `git mv`
 * removes its tracked files but leaves behind the untracked `node_modules/`
 * directory git never tracked. The leftover dir lingers on disk in long-lived
 * checkouts (notably the `main` worktree where `./singularity build` runs) while
 * being absent from freshly-created worktrees. Without this gate the purely
 * positional walk resurrects each such shell as a phantom plugin, so discovery —
 * and every check/codegen step built on it — diverges between a clean worktree
 * and a cruft-laden one. That non-determinism is exactly how a branch can pass
 * `push` checks yet break `main`'s build.
 *
 * The gate stays positional (it keys on "is this a hollow shell", never on a
 * specific marker file like package.json), so a freshly authored, not-yet-
 * committed plugin — whose real `.ts` files count as content — is still found.
 */
async function hasPluginContent(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code == null) throw err;
    return false;
  }
  for (const e of entries) {
    if (e.isFile()) return true;
    if (
      e.isDirectory() &&
      isWalkable(e.name) &&
      (await hasPluginContent(join(dir, e.name)))
    ) {
      return true;
    }
  }
  return false;
}

async function findAllPluginDirs(pluginsRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 10) return;
    // Purely positional: any directory visited here (other than the root itself)
    // sits at a plugin position, so it is a plugin — provided it actually holds
    // source content and isn't a hollow shell left behind by a relocation.
    if (dir !== pluginsRoot && (await hasPluginContent(dir))) out.push(dir);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code == null) throw err;
      return;
    }
    const subWalks: Promise<void>[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!isWalkable(e.name)) continue;
      if (dir === pluginsRoot) {
        subWalks.push(walk(join(dir, e.name), depth + 1));
      } else if (e.name === "plugins") {
        const sub = join(dir, e.name);
        subWalks.push(
          readdir(sub, { withFileTypes: true })
            .then((childEntries) =>
              Promise.all(
                childEntries
                  .filter((c) => c.isDirectory() && isWalkable(c.name))
                  .map((c) => walk(join(sub, c.name), depth + 1)),
              ),
            )
            .then(() => undefined)
            .catch((err) => {
              if ((err as NodeJS.ErrnoException).code != null) return;
              throw err;
            }),
        );
      }
    }
    await Promise.all(subWalks);
  }
  await walk(pluginsRoot, 0);
  return out;
}

// ── Per-plugin collection ───────────────────────────────────────────

interface CollectedPlugin {
  node: PluginNode;
  parentDir: string | null;
}

async function collectCoreFields(
  dir: string,
  pluginsRoot: string,
): Promise<CollectedPlugin> {
  const [webIndex, serverIndex, machineIndex, centralIndex, pkgSrc] =
    await Promise.all([
    readIfExistsAsync(join(dir, "web", "index.ts")),
    readIfExistsAsync(join(dir, "server", "index.ts")),
      readIfExistsAsync(join(dir, "machine", "index.ts")),
    readIfExistsAsync(join(dir, "central", "index.ts")),
    readIfExistsAsync(join(dir, "package.json")),
  ]);

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
      if (pkg.singularity?.collapsed === true) collapsed = true;
      if (pkg.singularity?.compositionRoot === true) compositionRoot = true;
      // eslint-disable-next-line promise-safety/no-bare-catch
    } catch {}
  }

  const rel = relative(pluginsRoot, dir);
  const segs = rel.split(/[\\/]+/);
  let parentDir: string | null = null;
  if (segs.length >= 3 && segs[segs.length - 2] === "plugins") {
    parentDir = join(pluginsRoot, ...segs.slice(0, segs.length - 2));
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

export async function buildPluginTree(
  pluginsRoot: string,
  opts?: { skipBarrelImport?: boolean; facets?: boolean },
): Promise<PluginTree> {
  // Step 1: find all plugin directories (async fs walk — does not block event loop)
  // Sort to restore deterministic ordering (parallel walks complete in arbitrary order).
  const dirs = (await findAllPluginDirs(pluginsRoot)).sort();

  // Step 2: collect core fields for each plugin (async parallel reads)
  const byDir = new Map<string, PluginNode>();
  const byPath = new Map<string, PluginNode>();
  const parentDirs = new Map<string, string | null>();

  const collected = await Promise.all(
    dirs.map((d) => collectCoreFields(d, pluginsRoot)),
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
        parent = join(pluginsRoot, ...segs.slice(0, segs.length - 2));
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

  const tree: PluginTree = { pluginsRoot, byDir, byPath, roots, facets: [] };

  // Step 4a: barrel import (web → server → machine → central) — gated on `facets` (and, as
  // before, skippable within a facet build via `skipBarrelImport`). Only the 2
  // runtime facets (contributions runtime part, registrations) need imported
  // modules. The other 7 facets parse files from disk and populate without barrels.
  const importedModules = new Map<
    string,
    {
      mod: Record<string, unknown>;
      runtime: "web" | "server" | "machine" | "central";
    }[]
  >();
  if (opts?.facets && !opts?.skipBarrelImport) {
    registerBarrelStubs(join(pluginsRoot, ".."));

    // Seed web-sdk core barrel (defines Core.Root etc. — needed for slot display names)
    const webSdkCoreBarrel = join(
      pluginsRoot,
      "framework/plugins/web-sdk/core/index.ts",
    );
    if (existsSync(webSdkCoreBarrel)) {
      const coreMod = await importBarrel(webSdkCoreBarrel);
      const webSdkDir = join(pluginsRoot, "framework/plugins/web-sdk");
      if (byDir.has(webSdkDir)) {
        importedModules.set(webSdkDir, [{ mod: coreMod, runtime: "web" }]);
      }
    }

    for (const runtime of ["web", "server", "machine", "central"] as const) {
      for (const node of byDir.values()) {
        const barrelPath = join(node.dir, runtime, "index.ts");
        if (!existsSync(barrelPath)) continue;

        const mod = await importBarrel(barrelPath);

        let mods = importedModules.get(node.dir);
        if (!mods) {
          mods = [];
          importedModules.set(node.dir, mods);
        }
        mods.push({ mod, runtime });
      }
    }
  }

  // Steps 4b + 4c: facet extract + relate — gated on `facets`. When `facets` is
  // falsy this whole block is skipped: no `loadFacets`/`buildFsSnapshot`, no
  // extract, no relate — so `tree.facets` stays `[]` and every `node.facets`
  // stays `{}` (its init value). Structure-only is steps 1–3, the cheap async
  // skeleton the hot callers need.
  if (opts?.facets) {
    // Step 4b: facet extract. Static facets fully populate; runtime facets are
    // partial (empty importedModules) under skipBarrelImport — acceptable.
    //
    // The facet `extract`/`relate` functions are synchronous and re-read the whole
    // plugin source tree several times over via sync `readFileSync`/`readdirSync`,
    // which monopolizes the single event loop for many seconds. To make that fast
    // AND non-blocking without changing any facet body or the tree's output: read
    // every needed file ONCE, asynchronously and in parallel, into an in-memory
    // snapshot, then run the (still-synchronous) extract/relate against it via the
    // ambient-snapshot hook in parse-utils — so the loops touch zero disk. The
    // snapshot build runs in parallel with the (async) facet-module load.
    const [facets, fsSnapshot] = await Promise.all([
      loadFacets(),
      buildFsSnapshot(join(pluginsRoot, ".."), dirs),
    ]);
    tree.facets = facets;

    // IMPORTING THE BARRELS IS WHAT DECLARES THE SLOTS. A slot's id is derived
    // from the plugin that declares it, so a slot nobody has declared has no id
    // at all — and a facet that reads one off a contribution (`contributions`
    // names the slot each contribution targets) would silently see nothing and
    // report an empty set, which reads downstream as "this plugin contributes
    // nothing" rather than as the tooling failure it is.
    //
    // Running the pass HERE, over exactly the modules just imported, is what
    // makes that impossible: any consumer holding an enriched tree holds
    // declared slots. Plugins the app's composition leaves out are included
    // deliberately — their barrels were imported too, and a facet describes
    // source, not the live registry (the runtime sets filter on composition
    // membership separately).
    //
    // `"source"` is the scope this pass models, and it is what the paragraph
    // above says in one word: every plugin the checkout declares, excluded ones
    // included. An `out-of-scope` answer from this naming therefore means the
    // slot is declared by nobody anywhere, not merely by nobody the browser
    // loads.
    const naming = declarePluginSlots(
      [...byDir.values()].flatMap((node) => {
        const mods = importedModules.get(node.dir) ?? [];
        return mods.flatMap((m) => {
          const slots = declaredSlotSources(m.mod);
          return slots ? [{ id: node.id, slots }] : [];
        });
      }),
      "source",
    );
    // The extract loop shares its thread with whoever else is running (a check
    // pass runs ~100 checks on it), so it yields a macrotask after ~10 ms of work
    // rather than per node count: one node's facets can cost far more than
    // another's, and a fixed count let a heavy stretch hold the thread for
    // seconds. The reads are in-memory, so this bounds CPU, not I/O.
    const slice = createTimeSlicer();
    for (const node of byDir.values()) {
      const nodeModules = importedModules.get(node.dir) ?? [];
      for (const facet of facets) {
        runWithFsSnapshot(fsSnapshot, () => {
          const data = facet.extract({
            dir: node.dir,
            pluginId: node.id,
            // The modules and the naming travel as ONE value: a facet cannot be
            // handed barrels without the pass that names the slots their
            // contributions point at. See `ExtractContext.imported`.
            imported: { modules: nodeModules, naming },
            fs: fsSnapshot,
          });
          setFacet(node, facet.def, data);
        });
        await slice();
      }
    }

    // Step 4c: async whole-tree passes a facet runs before ANY relate, so a
    // relate (its own or a later facet's) reads their results.
    for (const facet of facets) {
      if (facet.prepareRelate)
        await facet.prepareRelate({ tree, fs: fsSnapshot });
    }
    // Step 4d: facet relate. `relate` (e.g. routes/cross-refs) also walks every
    // plugin's source, so it reads from the same snapshot. Yield between facets so
    // the residual block is one facet's relate, not all of them summed.
    for (const facet of facets) {
      if (!facet.relate) continue;
      runWithFsSnapshot(fsSnapshot, () => facet.relate!({ tree }));
      await yieldMacrotask();
    }
  }

  return tree;
}
