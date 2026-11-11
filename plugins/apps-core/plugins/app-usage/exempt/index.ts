import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/components/app-usage-recorder.tsx"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: app usage is the page's, recorded against the page's own server whatever subtree is focused (D3).",
  },
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "Absent from the standalone website by design: it records the owner's own app usage against their server, and a public site's visitors are analytics' job (apps/deploy/analytics/collect), never this ledger.",
  },
] satisfies Exemptions;
