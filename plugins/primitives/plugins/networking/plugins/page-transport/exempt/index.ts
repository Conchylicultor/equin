import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "networking/no-request-guard-capability",
    paths: ["web/page-transport.ts"],
    kind: "sanctioned",
    reason:
      "The page's transport IS the low-level fetch every request of the page's own traffic goes through, so it holds the request guard's nativeFetch; the rest of the app reaches the server only via the transport.",
  },
] satisfies Exemptions;
