import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-void-fetch-endpoint",
    paths: ["web/components/pages-sidebar.tsx"],
    kind: "sanctioned",
    reason:
      "Page-tree expand toggle + DnD reorder; the page_blocks push refreshes.",
  },
] satisfies Exemptions;
