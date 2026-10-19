import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-legacy-resource-spelling",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "The substrate: defines the old live-resource spellings, or is compiled onto them (the live API, the optimistic overlay, the runtime and its server / central facades).",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web"],
    kind: "sanctioned",
    reason:
      "The substrate: useLive and its paged reads are built on TanStack query hooks; this is where a live read is implemented, not a request/response read site.",
  },
  {
    rule: "no-raw-websocket",
    paths: ["e2e/narrowing.ts"],
    kind: "sanctioned",
    reason:
      "A measurement script run under bun, not a browser tab: it counts every frame the server sends each live tuple, so it speaks the wire protocol on its own raw socket (SharedWebSocket is a browser SharedWorker primitive).",
  },
] satisfies Exemptions;
