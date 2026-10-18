import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:no-hardcoded-paths",
    paths: ["core/derive.ts"],
    kind: "sanctioned",
    reason:
      "Deploy owns the REMOTE host's layout \u2014 a different machine's filesystem, reached over SSH. `paths` resolves paths on THIS machine, and a dev-host constant in a generated remote script would be silently wrong (the laptop is macOS, the target is Ubuntu).",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["server/internal/transcript.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
