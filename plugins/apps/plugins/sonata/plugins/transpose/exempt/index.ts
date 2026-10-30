import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-void-fetch-endpoint",
    paths: ["web/actions.ts"],
    kind: "sanctioned",
    reason:
      "Per-song global transpose offset; set optimistically on the shell store first, and the transposes row push reaffirms it — a failed persist self-corrects on the next step.",
  },
] satisfies Exemptions;
