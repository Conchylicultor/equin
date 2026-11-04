import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/timed-fs.ts"],
    kind: "sanctioned",
    reason:
      "the timed twin of node:fs is node:fs by definition, and it must sit in core/ — the one folder every process's code (server, machine, central, core, cli, check, bin, scripts) may import",
  },
  {
    rule: "timed-fs/no-untimed-fs-read",
    paths: ["core/internal/timed-fs.ts"],
    kind: "sanctioned",
    reason:
      "the timed calls wrap node:fs's own — the one place the untimed ones are called",
  },
] satisfies Exemptions;
