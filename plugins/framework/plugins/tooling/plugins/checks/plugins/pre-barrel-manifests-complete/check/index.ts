import { joinAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { join, relative, resolve } from "path";
import type {
  Check,
  CheckContext,
  RepoFiles,
} from "@plugins/framework/plugins/tooling/core";
import {
  barrelStubsPath,
  discoverBrowserHosts,
  postWebManifests,
  preBarrelManifests,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import { discoverCollectedDirsIn } from "@plugins/framework/plugins/tooling/plugins/collected-dir/plugins/discovery/core";
import { collectedDirRegistryPath } from "@plugins/framework/plugins/tooling/plugins/codegen/plugins/composition-registries/core";
import { buildStructureTreeOnce } from "@plugins/plugin-meta/plugins/plugin-tree/plugins/structure-records/core";
import { fileSetRuntimeReach } from "@plugins/plugin-meta/plugins/plugin-records/core";

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
  const tree = await buildStructureTreeOnce(
    joinAppPath(repo.root, "plugins"),
    repo,
  );
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
 * Every file ending in `.generated.ts` that `roots` (absolute) load WITH them
 * — their static reach, what a barrel's module-load evaluates — read off the
 * plugin-records module graph (`fileSetRuntimeReach`), the one source of a
 * module's resolved imports: a pass after an edit scans the edited modules
 * alone, and the web closure asked first is part of the same shared graph the
 * full reach grows. Absolute, normalized paths.
 */
async function reachableGenerated(
  repo: RepoFiles,
  roots: readonly string[],
): Promise<Set<string>> {
  const reach = await fileSetRuntimeReach(
    repo,
    roots.map((r) => relative(repo.root, r)),
    { dynamic: false },
  );
  const generated = new Set<string>();
  for (const m of reach.keys())
    if (m.endsWith(".generated.ts")) generated.add(resolve(repo.root, m));
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
    // Both questions grow ONE module graph of the set: the full reach walks
    // only what the web reach did not.
    const fromWeb = await reachableGenerated(repo, web);
    const reachable = await reachableGenerated(repo, [...web, ...rest]);

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
