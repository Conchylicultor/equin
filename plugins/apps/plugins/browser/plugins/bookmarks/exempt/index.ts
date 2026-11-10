import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "pane/no-pane-header-bar",
    paths: ["web/components/bookmarks-bar.tsx"],
    kind: "sanctioned",
    reason:
      "A secondary chip row under the browser toolbar, not a pane header: it is tuned to the mockup's fixed `h-chrome-pane` row (26px chips centred in it), which `tier=\"subpane\"`'s content-sized `py-xs` strip would change.",
  },
] satisfies Exemptions;
