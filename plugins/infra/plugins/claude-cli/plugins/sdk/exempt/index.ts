import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "claude-sdk/no-direct-sdk-query",
    paths: ["server/internal/session.ts"],
    kind: "sanctioned",
    reason:
      "claudeQuery itself: the one call to the Agent SDK's query(), taking the account's environment every other session must go through.",
  },
  {
    rule: "user-path/no-unproven-claim",
    paths: ["machine/internal/bundled-bin.ts"],
    kind: "sanctioned",
    reason:
      "A file of the app's own node_modules install, resolved by the module resolver.",
  },
] satisfies Exemptions;
