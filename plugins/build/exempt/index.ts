import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "page-hosts-on-demand",
    paths: ["web/index.ts"],
    kind: "sanctioned",
    reason:
      "Absent from the standalone website's page: it holds build only on demand, inside the live demo, whose deployment description is the demo host's — so there is no served site build for the update policy (UpdatePolicyRoot) to compare this page against. A public site page never carried the Build tray or its Reload either; an old site page whose files are gone is the boot-failure screen's (web-core index.html reloads it when the served import map changed).",
  },
] satisfies Exemptions;
