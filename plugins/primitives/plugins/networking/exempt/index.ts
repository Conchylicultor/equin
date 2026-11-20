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
    paths: ["web/use-reconnecting-ws.ts", "web/shared-websocket.ts"],
    kind: "sanctioned",
    reason:
      "useReconnectingWebSocket is the per-tab socket primitive (opened on the subtree's transport, refused where no URL reaches it), and SharedWebSocket's in-page host (a browser without SharedWorker / Web Locks) is the page's shared socket run in the page: both open their socket past the request guard with nativeWebSocket.",
  },
  {
    rule: "dom-access-safety/no-module-scope-dom",
    paths: ["web/shared-ws.worker.ts"],
    kind: "sanctioned",
    reason:
      "The SharedWorker entry: built as its own chunk and started by `new SharedWorker(new URL(...))`, never imported, so no module graph evaluates it. It needs navigator.locks once, at worker start, and fails loudly when it is missing.",
  },
  {
    rule: "web-locks/no-raw-navigator-locks",
    paths: ["web/shared-ws.worker.ts"],
    kind: "sanctioned",
    reason:
      "The SharedWorker entry is bundled whole and may import no other plugin (web-artifacts' inline audit), so it cannot reach webLocks(). It is started only by a page whose webLocks() is supported (shared-websocket.ts's defaultSeams), and fails loudly if its own context has none.",
  },
] satisfies Exemptions;
