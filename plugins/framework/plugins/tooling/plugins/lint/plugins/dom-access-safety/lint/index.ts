import noModuleScopeDom from "./no-module-scope-dom";
import noRootStyleWrite from "./no-root-style-write";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "dom-access-safety",
  rules: {
    "no-module-scope-dom": noModuleScopeDom,
    "no-root-style-write": noRootStyleWrite,
  },
} satisfies LintContribution;
