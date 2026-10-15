import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "data-view/no-adhoc-row-list",
    paths: ["."],
    kind: "sanctioned",
    reason:
      "These primitives ARE the row-rendering machinery (DataView's own list/table views, the tree primitive, and the reorder editor), so mapping into <Row> is their implementation.",
  },
] satisfies Exemptions;
