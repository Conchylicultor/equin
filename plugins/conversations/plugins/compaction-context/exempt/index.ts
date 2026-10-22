import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/hook-entry.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["shared/client.ts"],
    kind: "sanctioned",
    reason:
      "Runs in the agent's SessionStart(compact) hook process (`bin/compaction-context.ts`), never in a page: it dials the backend the agent was launched by, at the URL it was handed — no subtree, no transport.",
  },
] satisfies Exemptions;
