import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: [
      "server/internal/activity-resource.ts",
      "server/internal/transcript-resource.ts",
    ],
    kind: "debt",
    task: "task-1791766351-ziteb8",
    reason:
      "Its external loader resolves the conversation's transcript chain from Postgres (`resolveConversationTranscriptPaths` → `getConversationClaudeSessionId` / `listSessionChain`) before reading the subagent files, so a change to those rows is invisible to it. Make the lookup an honest input (a param, or a db-served value it derives from) and drop the DB read from the external loader.",
  },
] satisfies Exemptions;
