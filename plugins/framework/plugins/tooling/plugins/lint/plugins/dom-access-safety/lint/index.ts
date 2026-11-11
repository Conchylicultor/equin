import noModuleScopeDom from "./no-module-scope-dom";
import noRenderTimeDom from "./no-render-time-dom";
import noRootStyleWrite from "./no-root-style-write";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "dom-access-safety",
  rules: {
    "no-module-scope-dom": noModuleScopeDom,
    "no-render-time-dom": noRenderTimeDom,
    "no-root-style-write": noRootStyleWrite,
  },
  noDebt: ["no-module-scope-dom", "no-render-time-dom"],
} satisfies LintContribution;
