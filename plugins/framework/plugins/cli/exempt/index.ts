import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/claudemd-conflicts.ts",
      "core/internal/git-dir.ts",
      "core/internal/merge-markers.ts",
      "core/internal/registry-entry.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "cli:codegen-manifests-not-frozen:registry",
    paths: ["core/cli.generated.ts"],
    kind: "sanctioned",
    reason:
      "The command table: every invocation evaluates it at startup to give commander its verbs. Stage 1 rewrites it inside `build`, but that process has already routed and never reads it again; a new command is routed by the next invocation.",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: [
      "core/internal/git-dir.ts",
      "core/internal/merge-markers.ts",
      "core/internal/registry-entry.ts",
    ],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
] satisfies Exemptions;
