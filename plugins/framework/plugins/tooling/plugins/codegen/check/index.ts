import { join } from "path";
import type {
  Check,
  CheckResult,
} from "@plugins/framework/plugins/tooling/core";
import {
  asFsPath,
  isTestCodePath,
} from "@plugins/framework/plugins/plugin-id/core";
import { listCandidateSources } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import {
  importBarrel,
  registerBarrelStubs,
} from "@plugins/plugin-meta/plugins/barrel-import/core";
import {
  buildRegistryGenContext,
  discoverBrowserHosts,
  inferBrowserHostGraph,
  parseServerContributionDeclarations,
  resolveHostContributionCoverage,
  serverBarrelBlockers,
  type HostContributionBarrel,
  type ServerContributionKindDecl,
} from "../core";

/** The plugin (`a/plugins/b`) a repo path sits in, or null outside a plugin folder. */
function pluginOf(rel: string): string | null {
  if (!rel.startsWith("plugins/")) return null;
  const segs = rel.slice("plugins/".length).split("/");
  const plugin = [segs[0]!];
  let i = 1;
  while (segs[i] === "plugins" && i + 1 < segs.length - 1) {
    plugin.push(segs[i + 1]!);
    i += 2;
  }
  return i >= segs.length - 1 ? null : plugin.join("/plugins/");
}

type RawContribution = { _kind?: symbol; _doc?: { label?: string } };

/**
 * The browser-host coverage guard's contributions arm
 * (`resolveHostContributionCoverage`, codegen's `browser-host-coverage.ts`): a
 * scoped web plugin whose `server/` barrel a browser host does not boot must
 * not contribute to a kind a graph member declares — unless the kind declares
 * `absentOnHost`. It reads contributions, which only an imported barrel holds,
 * so it runs here rather than in the barrel-free graph derivation. Nothing
 * exempts it.
 */
const check: Check = {
  id: "browser-host:contributions-covered",
  description:
    "every server contribution a browser host's scoped web plugins make, to a kind a graph member declares (and not `absentOnHost`), comes from a `server/` barrel the host boots",
  async run(ctx): Promise<CheckResult> {
    const repo = await ctx.repo();
    const gen = await buildRegistryGenContext(repo.root, repo);

    const kinds = new Map<
      string,
      (ServerContributionKindDecl & { plugin: string })[]
    >();
    for (const { rel, src } of await listCandidateSources({
      root: repo.root,
      grepArg: "defineServerContribution",
      fixed: true,
    })) {
      if (isTestCodePath(rel.split("/"))) continue;
      const plugin = pluginOf(rel);
      if (plugin === null) continue;
      for (const d of parseServerContributionDeclarations(src)) {
        kinds.set(d.kind, [...(kinds.get(d.kind) ?? []), { ...d, plugin }]);
      }
    }

    registerBarrelStubs(repo.root);
    const problems: string[] = [];
    for (const host of discoverBrowserHosts(repo)) {
      const graph = await inferBrowserHostGraph(gen, host);
      const members = new Set(graph.members);
      const barrels: HostContributionBarrel[] = [];
      for (const id of graph.webPlugins) {
        const plugin = asFsPath(id);
        if (members.has(plugin)) continue;
        const barrel = `plugins/${plugin}/server/index.ts`;
        if (!repo.has(barrel)) continue;
        const mod = await importBarrel(join(repo.root, barrel));
        const def = mod.default as
          { contributions?: readonly RawContribution[] } | undefined;
        barrels.push({
          plugin,
          barrel,
          contributions: (def?.contributions ?? []).flatMap((c) =>
            typeof c._kind === "symbol" && c._kind.description !== undefined
              ? [{ kind: c._kind.description, label: c._doc?.label }]
              : [],
          ),
        });
      }
      problems.push(
        ...(await resolveHostContributionCoverage({
          label: graph.label,
          members: graph.members,
          webPlugins: graph.webPlugins,
          barrels,
          kinds,
          blockers: (barrel) => serverBarrelBlockers(repo.root, repo, barrel),
        })),
      );
    }
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message: `${problems.length} scoped plugin(s) contribute to kinds a browser host's graph reads from a \`server/\` barrel the host does not boot — the host would answer without the contribution:\n  - ${problems.join("\n  - ")}`,
      hint: "Make the contributing `server/` barrel `portable: true` (its closure must pass `boundaries:portable-closure`), or move the contribution into a portable `server/` half and the rest into `machine/`. A kind whose contributions never shape what a host serves declares `absentOnHost: { reason }` on its `defineServerContribution`.",
    };
  },
};

export default check;
