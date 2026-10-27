import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["machine/internal/rewind-preview-served.ts"],
    kind: "sanctioned",
    reason:
      "conversations.rewind-preview is a `snapshot`: the cut is re-measured on every ask (the Rewind / Fork click), never pushed. Its truth is the agent's transcript on disk, which no change feed sees; the one Postgres read (the conversation row, via previewRewind → getConversation) is taken at that same instant, so a `db` read-set would add nothing a snapshot does not already re-read.",
  },
] satisfies Exemptions;
