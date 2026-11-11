import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/internal/channel.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: a site page's error reports (its collectors catch the live demo's too) always reach the page's own server — the site's public intake (D3).",
  },
] satisfies Exemptions;
