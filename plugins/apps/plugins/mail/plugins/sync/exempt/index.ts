import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "no-db-backed-notify",
    paths: ["server/internal/search-value.ts"],
    kind: "sanctioned",
    reason:
      "mail.search's answer is Gmail's alone (ranked thread ids from messages.list; `fixed`, no notify). Its loader's only Postgres access is the mirror WRITE of the envelopes it saw (upsertMessageEnvelope / markMessagesWithAttachments) — allowed in an external loader — whose thread-rollup recompute (store.ts recomputeThread) re-reads the message rows it just wrote; the lexical scan counts that read-modify-write as a read of the answer.",
  },
] satisfies Exemptions;
