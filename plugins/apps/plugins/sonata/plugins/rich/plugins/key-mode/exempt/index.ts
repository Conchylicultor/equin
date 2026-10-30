import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-void-fetch-endpoint",
    paths: ["web/actions.ts"],
    kind: "sanctioned",
    reason:
      "Per-song key-auto-detect toggle; set optimistically on the shell store first, and the keyAutoDetects row push reaffirms it — a failed persist self-corrects on the next toggle.",
  },
] satisfies Exemptions;
