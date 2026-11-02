import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "live/no-legacy-resource-spelling",
    // Exactly the files compiled onto the substrate — never the whole plugin,
    // so no new file of the live API (a second read hook among them) can
    // reach for an old spelling unseen.
    paths: [
      "central/internal/serve-value.ts",
      "server/internal/serve-collection.ts",
      "server/internal/serve-off-feed.ts",
      "server/internal/serve-union.ts",
      "server/internal/serve-value.ts",
      "web/internal/use-live.ts",
      "web/internal/use-pages.ts",
    ],
    kind: "sanctioned",
    reason:
      "The substrate: the live API's serve and read halves are compiled onto the old live-resource spellings (the runtime's resources, query-resource's compilers, live-state's useResource / useResources).",
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
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/index.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
] satisfies Exemptions;
