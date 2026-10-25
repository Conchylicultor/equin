import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/compute-edited-files.ts",
      "server/internal/edited-files-signature.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "no-raw-websocket",
    paths: ["e2e/edited-files-cost.ts"],
    kind: "sanctioned",
    reason:
      "A measurement script run under bun, not a browser tab: it speaks the live-resource wire protocol directly to count the edited-files frames and loader runs a change causes, so it needs its own raw socket (SharedWebSocket is a browser SharedWorker primitive).",
  },
] satisfies Exemptions;
