import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:data-root-not-joined",
    paths: ["bin/launch.ts"],
    kind: "sanctioned",
    reason:
      "The release launcher and its teardown twin SET the root (`??=`) and read back what they just wrote, before anything path-dependent is imported: the processes that decide what the root IS.",
  },
  {
    rule: "marker-scan-safety/no-adhoc-marker-scan",
    paths: ["check/internal/strip-comments.ts"],
    kind: "sanctioned",
    reason:
      "Token-in-string: the launcher checks look for SINGULARITY_* variable names, which code spells inside strings (an `env` object key, a `process.env[…]` subscript) with no enclosing marker call — a full mask would erase the names. It only needs comments (and regex literals) blanked.",
  },
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["server/internal/boot.ts"],
    kind: "sanctioned",
    reason:
      "The gateway's launch, run by the CLI (`./singularity start`), serve-app and the release launcher — never by a backend. The gateway outlives the call by design (it is the parent of every backend), and its stdio is a caller-owned log fd. Not a daemon: no backend starts it, so there is no catalog to list it in from here — each backend `attach`es it instead (launcher/server/internal/gateway-daemon.ts).",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/boot.ts",
      "server/internal/config-propagate.ts",
      "server/internal/launchd-service.ts",
      "server/internal/systemd-service.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
