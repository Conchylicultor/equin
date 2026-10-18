import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import noPlatformApi from "./no-platform-api";

export default {
  name: "boundaries",
  rules: {
    "no-platform-api": noPlatformApi,
  },
  // A `scripts/` file is run by path on the host, never imported, so it never
  // loads in a browser even when it sits under a forbidden folder.
  outOfScope: { "no-platform-api": ["script"] },
} satisfies LintContribution;
