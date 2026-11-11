import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "Absent from the standalone website's live demo, which falls back to the morph's documented fallback — plain navigation on a cross-app Expand. Whether the site should carry it for visual parity: task-1794361895-zkzb9g.",
  },
] satisfies Exemptions;
