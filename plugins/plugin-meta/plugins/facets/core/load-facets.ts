import { loadCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
import type { Facet } from "./facets";

function isFacet(value: unknown): value is Facet {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Facet).def === "object" &&
    typeof (value as Facet).extract === "function" &&
    typeof (value as Facet).renderDoc === "function"
  );
}

export async function loadFacets(): Promise<Facet[]> {
  // loadFacets is build/server-only (it reads facet/ folders via fs) and never
  // runs in the browser. The specifier is held in a variable so the repo's
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
