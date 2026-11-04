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
] satisfies Exemptions;
