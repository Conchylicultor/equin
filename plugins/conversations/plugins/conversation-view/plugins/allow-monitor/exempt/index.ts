import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/allow-files-resource.ts"],
    kind: "debt",
    task: "task-1791766351-ziteb8",
    reason:
      "Its external loader looks the conversation up in Postgres (`getConversation` / `getConversationClaudeSessionId`, for the worktree path or Claude session id) before reading the filesystem, so a change to that row is invisible to it. Make the lookup an honest input (a param, or a db-served value it derives from) and drop the DB read from the external loader.",
  },
] satisfies Exemptions;
