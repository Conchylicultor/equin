import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

// `checkout` membership: a check polices this checkout's source, so every
// plugin on disk contributes its checks, those the composition excludes included.
export const checkCollectedDir = defineCollectedDir("check", {
  membership: "checkout",
});
