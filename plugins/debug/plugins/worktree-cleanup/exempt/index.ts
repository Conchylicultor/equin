import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints:no-raw-json-handlers",
    paths: ["server/internal/handle-delete.ts"],
    kind: "sanctioned",
    reason: "400/404 guards emitted before an NDJSON stream response.",
  },
  {
    rule: "live/no-endpoint-read",
    paths: ["web/components/worktree-cleanup-panel.tsx"],
    kind: "debt",
    task: "task-1791560308-woqgfi",
    reason:
      "A request/response server read (a GET fetchEndpoint or NDJSON stream an effect, a hook or a function they call runs) not yet moved onto a liveValue or liveCollection read with useLive.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/dirs.ts",
      "server/internal/reap-policy.ts",
      "server/internal/reap.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
