import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "product-name:legacy",
    paths: ["core/internal/product-name.ts"],
    kind: "sanctioned",
    reason: "The owner of the legacy-name list.",
  },
  {
    rule: "product-name:legacy-id",
    paths: [
      "core/internal/product-name.ts",
      "core/internal/legacy-ids.ts",
      "check/legacy-id.ts",
    ],
    kind: "sanctioned",
    reason:
      "The owners of the old name and of the kept ids built from it, and the check that bans them elsewhere.",
  },
  {
    rule: "cli:legacy-cli-name",
    paths: ["core/internal/legacy-ids.ts"],
    kind: "sanctioned",
    reason:
      "The owner of the kept ids, the legacy CLI shim's name among them, says what the shim is.",
  },
] satisfies Exemptions;
