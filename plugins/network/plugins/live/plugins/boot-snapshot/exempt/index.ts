import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-page-transport",
    paths: ["web/internal/boot.ts"],
    kind: "sanctioned",
    reason:
      "Boot belongs to the page: the boot snapshot hydrates the page's own pipeline from the page's own server, before any subtree exists.",
  },
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["web/internal/boot.ts"],
    kind: "sanctioned",
    reason:
      "The boot snapshot is a substrate read of live itself — it seeds the live-state cache before first paint, so it cannot be a useLive read. It is the page transport's raw fetch kept on the contract (endpointRequest + readEndpointResponse decode bootSnapshot's own codec).",
  },
] satisfies Exemptions;
