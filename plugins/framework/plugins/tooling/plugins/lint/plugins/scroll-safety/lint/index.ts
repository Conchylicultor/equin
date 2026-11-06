import noAdhocScrollIntoView from "./no-adhoc-scroll-into-view";
import noAdhocScrollWrite from "./no-adhoc-scroll-write";
import noScrollingFocus from "./no-scrolling-focus";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

export default {
  name: "scroll-safety",
  rules: {
    "no-adhoc-scroll-into-view": noAdhocScrollIntoView,
    "no-adhoc-scroll-write": noAdhocScrollWrite,
    "no-scrolling-focus": noScrollingFocus,
  },
} satisfies LintContribution;
