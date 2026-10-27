import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-raw-websocket",
    paths: ["web/shared-ws.worker.ts"],
    kind: "sanctioned",
    reason:
      "The networking primitive is where the one shared socket is built (inside its SharedWorker): every other client goes through SharedWebSocket or useReconnectingWs (which opens its socket through request-guard's nativeWebSocket).",
  },
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["web"],
    kind: "sanctioned",
    reason:
      "Primitives that legitimately wrap fetch(). These ARE the sanctioned low-level transport the rest of the app is forbidden from reaching for directly.",
  },
  {
    rule: "networking/no-request-guard-capability",
    paths: ["web/use-reconnecting-ws.ts"],
    kind: "sanctioned",
    reason:
      "useReconnectingWebSocket is the per-tab socket primitive (opened on the subtree's transport, refused where no URL reaches it): it opens its socket past the request guard with nativeWebSocket.",
  },
] satisfies Exemptions;
