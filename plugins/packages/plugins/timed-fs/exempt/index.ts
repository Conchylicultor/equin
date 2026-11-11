import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/timed-fs.ts", "core/internal/fs-call-count.ts"],
    kind: "sanctioned",
    reason:
      "the timed twin of node:fs is node:fs by definition (and its call count needs node:async_hooks for per-unit scopes and node:os for the home prefix), and it must sit in core/ — the one folder every process's code (server, machine, central, core, cli, check, bin, scripts) may import",
  },
  {
    rule: "timed-fs/no-untimed-fs-read",
    paths: ["core/internal/timed-fs.ts"],
    kind: "sanctioned",
    reason:
      "the timed calls wrap node:fs's own — the one place the untimed ones are called",
  },
  {
    rule: "paths:no-hardcoded-paths",
    paths: [
      "core/internal/fs-call-count.ts",
      "core/internal/fs-call-count.test.ts",
    ],
    kind: "sanctioned",
    reason:
      "the call count spells a path under the home dir as `~/…` for a prefix a person reads, never a path anything resolves; a leaf (node builtins only) cannot import paths/core's HOME_DIR",
  },
] satisfies Exemptions;
