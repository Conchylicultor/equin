import { join, relative, resolve } from "path";
import type {
  Check,
  CheckContext,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import {
  barrelStubsPath,
  collectImportGraph,
  collectedDirRegistryPath,
  discoverBrowserHosts,
  discoverCollectedDirsIn,
  postWebManifests,
  preBarrelManifests,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/core";

const RUNTIMES = ["web", "server", "machine", "central"] as const;

/**
 * The set of `*.generated.ts` files a barrel is ALLOWED to reach at module-load:
 *   - every pre-barrel manifest (regenerated before the first barrel import),
 *   - every post-web manifest (written between the web and server import
 *     phases — allowed to a SERVER/central barrel only, see below), and
 *   - the registry-phase outputs (collected-dir registries, the auto-stubs
 *     file and each browser host's page scope, `browserHost`) — these are
 *     written in the EARLIER, barrel-free `regenerateRegistryCodegen` phase, so
 *     they're always fresh by the time any barrel import happens in the
 *     manifest phase.
 *
 * Composition-filtered registries need no entry: they are reached only through
 * the `@composition-{web,server,machine}-registry` bundler alias or a variable dynamic
 * specifier, neither of which this check's static DFS follows.
 */
async function buildAllowSet(repo: RepoFiles): Promise<Set<string>> {
  const { root } = repo;
  const allow = new Set<string>();
  for (const m of preBarrelManifests) allow.add(resolve(m.path(root)));
  for (const m of postWebManifests) allow.add(resolve(m.path(root)));
  allow.add(resolve(barrelStubsPath(root)));
  for (const def of await discoverCollectedDirsIn(repo)) {
    allow.add(resolve(collectedDirRegistryPath(def)));
  }
  for (const host of discoverBrowserHosts(repo)) {
    allow.add(resolve(join(root, host.scopeGenerated)));
  }
  return allow;
}

/**
 * Every barrel file that the build imports, split by the phase that imports it.
 *
 * The split is what makes the post-web rule checkable: a post-web manifest is
 * written AFTER the web barrels are imported, so a web barrel reaching one would
 * freeze the previous run's copy — the exact failure the pre-barrel set exists
 * to prevent, one phase later. The web-sdk core seed is imported in the web
 * phase (buildPluginTree's Step 4a), so it counts as web.
 */
async function enumerateBarrels(
  repo: RepoFiles,
): Promise<{ web: string[]; rest: string[] }> {
  const tree = await buildStructureTreeOnce(join(repo.root, "plugins"));
  const web: string[] = [];
  const rest: string[] = [];

  const seed = "plugins/framework/plugins/web-sdk/core/index.ts";
  if (repo.has(seed)) web.push(join(repo.root, seed));

  for (const node of tree.byDir.values()) {
    for (const runtime of RUNTIMES) {
      const barrel = `plugins/${node.path}/${runtime}/index.ts`;
      if (!repo.has(barrel)) continue;
      (runtime === "web" ? web : rest).push(join(repo.root, barrel));
    }
  }
  return { web, rest };
}

/**
 * Every file ending in `.generated.ts` that `roots` reach over `graph`, which
 * `collectImportGraph` built from a superset of the same roots — so it holds
 * every file they reach. Absolute, normalized paths.
 */
function reachableGenerated(
  graph: Map<string, readonly string[]>,
  roots: readonly string[],
): Set<string> {
  const seen = new Set<string>();
  const generated = new Set<string>();
  const stack = roots.map((r) => resolve(r));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith(".generated.ts")) generated.add(file);
    const targets = graph.get(file);
    if (targets === undefined) {
      throw new Error(
        `${file} is reachable but absent from the import graph collected from the same roots`,
      );
    }
    stack.push(...targets);
  }
  return generated;
}

const check: Check = {
  id: "pre-barrel-manifests-complete",
  description:
    "every *.generated.ts reachable from a plugin barrel at module-load is a registered pre-barrel manifest (or a registry-phase output), and no web barrel reaches a post-web manifest",
  async run(ctx: CheckContext) {
    const repo = await ctx.repo();
    const { root } = repo;
    const allow = await buildAllowSet(repo);
    const { web, rest } = await enumerateBarrels(repo);
    // ONE reach from every barrel, read once; both questions below are asked
    // of it, so the web closure is not read and parsed a second time.
    const graph = await collectImportGraph(repo, [...web, ...rest]);
    const fromWeb = reachableGenerated(graph, web);
    const reachable = reachableGenerated(graph, [...web, ...rest]);

    const offenders = [...reachable]
      .filter((f) => !allow.has(f))
      .map((f) => relative(root, f))
      .sort();

    if (offenders.length > 0) {
      return {
        ok: false,
        message:
          `These generated files are imported by a plugin barrel at module-load ` +
          `but are NOT registered as pre-barrel manifests:\n` +
          offenders.map((p) => `  - ${p}`).join("\n"),
        hint:
          "Register it in preBarrelManifests (codegen/core/pre-barrel-manifests.ts) " +
          "so it's regenerated before the first barrel import, or stop importing it " +
          "from a barrel. Bun freezes a module on first import(), so a barrel-reachable " +
          "manifest that is generated after the first barrel import can never refresh.",
      };
    }

    // The post-web half: these are written AFTER the web barrels are imported,
    // so a web barrel reaching one freezes the previous run's copy.
    const postWebPaths = new Set(
      postWebManifests.map((m) => resolve(m.path(root))),
    );
    const webOffenders = [...fromWeb]
      .filter((f) => postWebPaths.has(f))
      .map((f) => relative(root, f))
      .sort();

    if (webOffenders.length === 0) return { ok: true };

    return {
      ok: false,
      message:
        `These POST-WEB manifests are imported by a WEB barrel at module-load:\n` +
        webOffenders.map((p) => `  - ${p}`).join("\n"),
      hint:
        "A post-web manifest (postWebManifests in codegen/core/pre-barrel-manifests.ts) " +
        "is written between the web and server import phases, so the web barrel that " +
        "imports it has already frozen the previous run's copy. Derive the value on " +
        "the web runtime instead (reorder reads it off the slot objects), or move the " +
        "manifest back into preBarrelManifests with a barrel-free renderer.",
    };
  },
};

export default check;
