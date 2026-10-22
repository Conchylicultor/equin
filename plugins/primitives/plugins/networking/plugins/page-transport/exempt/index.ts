import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["web/page-transport.ts"],
    kind: "sanctioned",
    reason:
      "The page's transport IS the low-level fetch every endpoint request of the page goes through; the rest of the app reaches it only via the transport.",
  },
] satisfies Exemptions;
