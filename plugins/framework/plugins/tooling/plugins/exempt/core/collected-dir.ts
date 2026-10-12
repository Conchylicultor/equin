import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";

// `checkout` membership: the registry lists EVERY plugin's manifest, those the
// `singularity` composition excludes included. Exemptions describe source, and
// their consumers (checks, the lint config) scan every plugin on disk — so the
// set a rule can be exempted on must be the set it scans, or an excluded
// plugin's violation has no spelling for its exemption.
export const exemptCollectedDir = defineCollectedDir("exempt", {
  membership: "checkout",
});
