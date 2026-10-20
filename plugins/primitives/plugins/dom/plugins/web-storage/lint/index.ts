import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import noRawWebStorage from "./no-raw-web-storage";

export default {
  name: "web-storage",
  rules: { "no-raw-web-storage": noRawWebStorage },
  // Tests and e2e scripts (out of scope by default) seed storage on purpose; a
  // script or CLI never runs in a browser.
  outOfScope: {
    "no-raw-web-storage": [
      "script",
      "bin",
      "central",
      "provision",
      "cli",
      "research",
    ],
  },
} satisfies LintContribution;
