import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-raw-web-fetch",
    paths: ["shared/client.ts"],
    kind: "sanctioned",
    reason:
      "Runs in the agent's SessionStart(compact) hook process (`bin/compaction-context.ts`), never in a page: it dials the backend the agent was launched by, at the URL it was handed — no subtree, no transport.",
  },
] satisfies Exemptions;
