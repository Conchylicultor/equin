import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

// `checkout` membership: guards watch the agent editing this checkout, so
// every plugin on disk contributes, those the composition excludes included.
export const guardCollectedDir = defineCollectedDir("guard", {
  membership: "checkout",
});
