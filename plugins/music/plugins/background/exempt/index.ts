import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "The standalone website holds the service only on demand (the live demo's Isle names it), and plays no background music: its page root — an audio player, a cross-tab channel and the across-apps config — is equin's own chrome, not the public site's, so the demo's island stays silent there.",
  },
] satisfies Exemptions;
