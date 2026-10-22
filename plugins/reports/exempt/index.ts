import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/report.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: report() files window.onerror, boot and crash-beacon reports, which belong to the page and always reach the page's own server (D3).",
  },
] satisfies Exemptions;
