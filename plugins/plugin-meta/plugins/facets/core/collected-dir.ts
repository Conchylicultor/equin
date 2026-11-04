import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

// `checkout` membership: facets extract the docs of every plugin on disk, so
// every plugin contributes, those the composition excludes included.
export const facetCollectedDir = defineCollectedDir("facet", {
  membership: "checkout",
});
