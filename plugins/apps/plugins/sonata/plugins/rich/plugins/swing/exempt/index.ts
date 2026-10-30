import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-void-fetch-endpoint",
    paths: ["web/actions.ts"],
    kind: "sanctioned",
    reason:
      "Per-song swing override; set optimistically on the song's setting first, and the swings row push reaffirms it — a failed persist self-corrects on the next change.",
  },
] satisfies Exemptions;
