import type { CheckContext } from "@plugins/framework/plugins/tooling/core";
import {
  buildRegistryGenContext,
  codegenPassOver,
  readCompositionManifestsFromDisk,
  scopedOnlyWebPlugins,
} from "@plugins/framework/plugins/tooling/plugins/codegen/core";
import {
  flattenManifest,
  resolveComposition,
} from "@plugins/plugin-meta/plugins/closure/core";
import { manifestItemToManifest } from "@plugins/plugin-meta/plugins/composition/core";
import { MAIN_COMPOSITION_ID } from "@plugins/infra/plugins/namespace/core";
import { getFacet } from "@plugins/plugin-meta/plugins/facets/core";
import { contributionsFacetDef } from "@plugins/plugin-meta/plugins/facets/plugins/contributions/core";
import {
  asFsPath,
  asPath,
  type PluginId,
} from "@plugins/framework/plugins/plugin-id/core";

type CheckResult = { ok: true } | { ok: false; message: string; hint?: string };
type Check = {
  id: string;
  description: string;
  exemptable?: Record<string, string>;
  run(ctx: CheckContext): Promise<CheckResult>;
};

const ID = "page-hosts-on-demand";

/** `scope: "page"`, as the contributions facet keeps the literal's source text. */
const PAGE_SCOPE = /^["'`]page["'`]$/;

/**
 * A page root host of a plugin a composition holds only on demand never runs
 * in that composition — unless its plugin says that is right.
 *
 * A composition that bundles a browser host's declaring plugin but not its
 * whole scope (the standalone website and its live demo) holds the rest on
 * demand: loaded into the scope, left out of every read at the page root. A
 * root mount declared `scope: "page"` (`RootScope`, web-sdk) is mounted only
 * at the page root — so one belonging to an on-demand plugin is mounted
 * nowhere. On main's `/demo` the same host runs (main bundles every plugin),
 * so nothing there shows what the site lacks: the site's error collectors were
 * missing that way.
 *
 * Each one is a decision: the composition holds the plugin as its own (the
 * host is page chrome it needs), the host serves every scope (`scope:
 * "each"`), or the plugin exempts itself here with why the site may lack it.
 * Every failure lists the hosts per composition.
 */
export const pageHostsOnDemand: Check = {
  id: ID,
  description:
    'No page root host (Core.Root / a root slot mount, scope "page") belongs to a plugin a composition holds only on demand — it would run nowhere there — unless its plugin exempts it with a reason',
  exemptable: {
    [ID]: "this plugin's page root host is legitimately absent from the compositions that hold the plugin only on demand (say why the page does without it)",
  },
  async run(ctx) {
    const repo = await ctx.repo();
    const regCtx = await buildRegistryGenContext(codegenPassOver(repo));
    const { tree, graph } = regCtx;
    const byId = new Map([...tree.byDir.values()].map((n) => [n.id, n]));
    const exempt = await ctx.exempt(ID);

    const items = readCompositionManifestsFromDisk(repo.root);
    const manifests = items.map(manifestItemToManifest);
    const problems: string[] = [];
    for (const item of items) {
      if (item.id === MAIN_COMPOSITION_ID) continue;
      const flat = flattenManifest(manifestItemToManifest(item), manifests);
      const { bundle } = resolveComposition(graph, flat);
      if (bundle.size === 0) continue;
      const onDemand = await scopedOnlyWebPlugins(regCtx, bundle);
      const hosts: string[] = [];
      for (const id of onDemand) {
        const node = byId.get(id);
        if (!node) continue;
        const mounts = (getFacet(node, contributionsFacetDef)?.static ?? [])
          .filter(
            (c) =>
              (c.slot === "Core.Root" || c.companion === true) &&
              PAGE_SCOPE.test(c.props["scope"] ?? ""),
          )
          .map((c) => `${c.slot} ${c.props["component"] ?? "?"}`);
        if (mounts.length === 0) continue;
        if (exempt.skips(`plugins/${asFsPath(id as PluginId)}/web/index.ts`)) {
          continue;
        }
        hosts.push(`${asPath(id as PluginId)} (${mounts.join(", ")})`);
      }
      if (hosts.length > 0) {
        problems.push(`${item.id}:\n    ${hosts.join("\n    ")}`);
      }
    }

    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      message:
        "Page root hosts of plugins held only on demand — mounted at no page of these compositions:\n  " +
        problems.join("\n  "),
      hint: 'Decide each host. Page chrome the composition needs → hold the plugin as the composition\'s own (name it, or a subsystem row it extends, in plugins/plugin-meta/plugins/composition/core/config.ts). A host of the plugins it reads → `scope: "each"`, keyed by usePluginScopeId(). Legitimately absent → exempt it from the owning plugin\'s exempt/index.ts (`rule: "page-hosts-on-demand"`, paths: ["web/index.ts"], with why). Current list: ./equin exempt list --rule page-hosts-on-demand.',
    };
  },
};
