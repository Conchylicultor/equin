import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/internal/client.ts"],
    kind: "sanctioned",
    reason:
      "Page-level health: the health probe asks the page's own server whether it is up.",
  },
  {
    rule: "networking/no-page-transport",
    paths: ["web/components/wedge-watchdog.tsx"],
    kind: "sanctioned",
    reason:
      "Page-level watchdog (Core.Root): probes the page pipeline's own live-state client for missed updates (getNotificationsClient) and the page's server health.",
  },
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["web/internal/client.ts"],
    kind: "sanctioned",
    reason:
      "The health probe must answer while the live socket is wedged (the wedge watchdog asks it), so it cannot be a live read. It is the page transport's raw fetch kept on the contract (endpointRequest + readEndpointResponse decode getHealth's own codec).",
  },
] satisfies Exemptions;
