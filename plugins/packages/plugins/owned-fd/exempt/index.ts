import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/owned-fd.ts"],
    kind: "sanctioned",
    reason:
      "an owned descriptor wraps node:fs by definition, and it must sit in core/ — the one folder every process's code (server, machine, central, core, cli, check, bin, scripts) may import",
  },
  {
    rule: "owned-fd/no-raw-fd-close",
    paths: ["core/internal/owned-fd.ts"],
    kind: "sanctioned",
    reason: "the one place a descriptor number is closed: OwnedFd#close",
  },
] satisfies Exemptions;
