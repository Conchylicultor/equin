import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "endpoints/no-void-fetch-endpoint",
    paths: ["web/components/pages-sidebar.tsx"],
    kind: "sanctioned",
    reason:
      "Page-tree expand toggle + DnD reorder; the page_blocks push refreshes.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/change-cover-popover.tsx",
      "web/components/new-page-item.tsx",
      "web/components/page-header.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — change-cover-popover.tsx: ChangeCoverPopover (unsupported syntax: Handle TryStatement with a finalizer ('finally') clause); new-page-item.tsx: NewPageItem (unsupported syntax: Handle TryStatement without a catch clause); page-header.tsx: GatedHeaderPart (calls a hook carried as a value).",
  },
] satisfies Exemptions;
