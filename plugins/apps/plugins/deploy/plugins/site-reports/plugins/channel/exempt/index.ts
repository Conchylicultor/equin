import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/internal/channel.ts"],
    kind: "sanctioned",
    reason:
      "Page-wide telemetry: a site page's error reports (its collectors catch the live demo's too) always reach the page's own server — the site's public intake (D3).",
  },
  {
    rule: "report-sink/collect-through-companion",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "Not a collector: the channel installs the site's delivery path into reports' own reportChannel request sink at register time, and is itself the opt-in — excluded everywhere by base-exclusions, named by the website alone.",
  },
] satisfies Exemptions;
