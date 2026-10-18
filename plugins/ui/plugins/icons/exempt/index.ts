import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "icons/reserved-nav-icon",
    paths: ["core/nav-icons.ts"],
    kind: "sanctioned",
    reason:
      "navIcons is where the reserved navigation glyphs are spelled — the one place the rule sends every other call site to.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["shared/symbol-names.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
