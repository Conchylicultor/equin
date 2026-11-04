import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

// `checkout` membership: a lint rule is enabled repo-wide over this checkout's
// source, so every plugin on disk contributes, those the composition excludes
// included.
export const lintCollectedDir = defineCollectedDir("lint", {
  membership: "checkout",
});
