import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "product-name:legacy-id",
    paths: ["core/plugin-moves.json"],
    kind: "sanctioned",
    reason:
      "The plugin-move ledger is history: each entry names the old plugin id it moved saved settings from.",
  },
  {
    rule: "relocate:moved-plugins-unnamed",
    paths: ["core/plugin-moves.json"],
    kind: "sanctioned",
    reason:
      "The plugin-move ledger is the record of every move: each entry names the id the plugin moved away from.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: [
      "core/internal/apply-moves.ts",
      "core/internal/ledger.ts",
      "core/internal/restamp-moved.ts",
    ],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
  {
    rule: "blocking-fs/sync-named",
    paths: [
      "core/internal/apply-moves.ts",
      "core/internal/ledger.ts",
      "core/internal/restamp-moved.ts",
    ],
    kind: "sanctioned",
    reason:
      "Host tooling only: no backend loads this module (blocking-fs:sync-named-reach measures the backends' import graph), so its blocking helpers hold only the CLI's, a check's or a script's own thread.",
  },
] satisfies Exemptions;
