import noDepthCountedPath from "./no-depth-counted-path";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "repo-root",
  rules: {
    // A `../` chain from a file's own location may not leave its plugin.
    "no-depth-counted-path": noDepthCountedPath,
  },
} satisfies LintContribution;
