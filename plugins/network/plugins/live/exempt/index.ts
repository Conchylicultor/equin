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
    rule: "no-db-backed-notify",
    paths: ["server/internal/serve-off-feed.ts"],
    kind: "sanctioned",
    reason:
      "The SQL arm of serveCollection served OFF the change feed (`changes`): it registers the compiled collection SQL as external resources by design. Its reads are not hand-written — every table the compiled SQL reads is declared `unfed` on the registration, the drift guard holds the loader to them, and change-feed's boot check refuses one the owner did not opt out of the feed (ExcludeFromChangeFeed).",
  },
  {
    rule: "no-raw-websocket",
    paths: ["e2e/narrowing.ts"],
    kind: "sanctioned",
    reason:
      "A measurement script run under bun, not a browser tab: it counts every frame the server sends each live tuple, so it speaks the wire protocol on its own raw socket (SharedWebSocket is a browser SharedWorker primitive).",
  },
  {
    rule: "endpoints/no-endpoint-effect-internals",
    paths: ["core/internal/predict.ts", "web"],
    kind: "sanctioned",
    reason:
      "The one client of a predicted endpoint: core's predict builders mint the effect (brandEndpointEffect) and read it back (endpointEffectPayload); web's useLiveMutation sends the write through its plain contract (endpointContractOf) once it has applied the effect.",
  },
] satisfies Exemptions;
