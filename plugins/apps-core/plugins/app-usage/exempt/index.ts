import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/components/app-usage-recorder.tsx"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: app usage is the page's, recorded against the page's own server whatever subtree is focused (D3).",
  },
] satisfies Exemptions;
