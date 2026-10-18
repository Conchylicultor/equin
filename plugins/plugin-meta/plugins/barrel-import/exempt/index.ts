import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "sortable-list/no-raw-dnd-kit",
    paths: ["core/internal/auto-stubs.generated.ts"],
    kind: "sanctioned",
    reason: "Stub table naming every package the barrel importer fakes.",
  },
  {
    rule: "boundaries/no-platform-api",
    paths: ["core/internal/stubs.ts"],
    kind: "debt",
    task: "task-1792338443-riwqev",
    reason: "not yet split into server/ + machine/",
  },
] satisfies Exemptions;
