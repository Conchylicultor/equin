import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import type { Facet } from "@plugins/plugin-meta/plugins/facets/core";

function isFacet(value: unknown): value is Facet {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Facet).def === "object" &&
    typeof (value as Facet).extract === "function" &&
    typeof (value as Facet).renderDoc === "function"
  );
}

/**
 * Each facet's source module (repo-relative), by facet id: what a facet's
 * plugin records are keyed by (its code's Merkle key), so editing one facet
 * re-extracts that facet and no other.
 *
 * A facet's id is its plugin directory's name — asserted, so a facet whose id
 * drifted from its folder fails here instead of keying its records on another
 * facet's code.
 */
export async function loadFacetSources(
  facets: readonly Facet[],
): Promise<Map<string, string>> {
  const generatedModule = "./facet.generated";
  const { facetEntries } = (await import(generatedModule)) as {
    facetEntries: { pluginPath: string }[];
  };
  const byId = new Map<string, string>();
  for (const e of facetEntries) {
    byId.set(
      e.pluginPath.slice(e.pluginPath.lastIndexOf("/") + 1),
      `plugins/${e.pluginPath}/facet/index.ts`,
    );
  }
  const out = new Map<string, string>();
  for (const f of facets) {
    const source = byId.get(f.def.id);
    if (source === undefined)
      throw new Error(
        `[facets] facet "${f.def.id}" lives in no facets/plugins/${f.def.id}/facet/ folder: a facet's id must be its plugin directory's name.`,
      );
    out.set(f.def.id, source);
  }
  return out;
}

export async function loadFacets(): Promise<Facet[]> {
  // loadFacets is build tooling: it runs in the CLI and the check runner,
  // never in a serving backend (which reads the faceted tree as data — see
  // plugin-tree/faceted's `plugin-tree-facets` command) and never in the
  // browser. The specifier is held in a variable so the repo's
  // static import-closure analysis (tooling/import-closure — e.g. the CLI's
  // codegen-manifests-not-frozen check) does not follow it into
  // facet.generated → every facet/ barrel → codegen. Rolldown folds the
  // constant into a literal, so the WEB build does follow it, into a lazy
  // chunk whose `@plugins/<p>/facet` loaders stay external and are never
  // built: a leaf folder's dynamic import is browser-unreachable
  // (web-artifacts' BROWSER_UNREACHABLE_DYNAMIC_KINDS).
  const generatedModule = "./facet.generated";
  const { facetEntries } = await import(generatedModule);
  // Facets are topo-sorted by `dependsOn` so a facet that relates against another
  // (e.g. contributions → slots) loads after its dependency.
  return loadCollectedDir<Facet>(facetEntries, { isItem: isFacet, ordered: true, label: "facet" });
}
