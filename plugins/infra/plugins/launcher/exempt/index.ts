import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "paths:data-root-not-joined",
    paths: ["bin/launch.ts"],
    kind: "sanctioned",
    reason:
      "The release launcher and its teardown twin SET the root (`setEnvDefault`) and read back what they just wrote, before anything path-dependent is imported: the processes that decide what the root IS.",
  },
  {
    rule: "marker-scan-safety/no-adhoc-marker-scan",
    paths: ["check/internal/strip-comments.ts"],
    kind: "sanctioned",
    reason:
      "Token-in-string: the launcher checks look for the app's environment variable names, which code spells inside strings (an `env` object key, a key literal handed to `readEnv`) with no enclosing marker call — a full mask would erase the names. It only needs comments (and regex literals) blanked.",
  },
  {
    rule: "spawn-safety/no-raw-bun-spawn",
    paths: ["server/internal/boot.ts"],
    kind: "sanctioned",
    reason:
      "The gateway's launch, run by the CLI (`./equin start`), serve-app and the release launcher — never by a backend. The gateway outlives the call by design (it is the parent of every backend), and its stdio is a caller-owned log fd. Not a daemon: no backend starts it, so there is no catalog to list it in from here — each backend `attach`es it instead (launcher/server/internal/gateway-daemon.ts).",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "server/internal/boot.ts",
      "server/internal/config-propagate.ts",
      "server/internal/release-swap.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "check-thread-safety/no-blocking-check-work",
    paths: ["check/internal/strip-comments.ts"],
    kind: "debt",
    task: "task-1793375830-dv7cez",
    reason:
      "Per-file synchronous work on the shared check thread (a blocking fs/process call made per item, or a direct maskSource / createSourceFile) that predates the rule; move it onto ctx.repo() / fs/promises and checks/core's maskedSource / parsedTsSource.",
  },
  {
    rule: "blocking-fs/no-sync-fs",
    paths: ["server/internal/boot.ts"],
    kind: "sanctioned",
    reason:
      "killListenerOnPort's `lsof` and gatewayLaunchSpec's ensureSync of the gateway's dirs run only in the launcher's own process (`./equin start` / `stop`, the release `launch` binary) bringing the stack up or tearing it down \u2014 never on a serving backend.",
  },
] satisfies Exemptions;
