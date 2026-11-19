import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "react-compiler:no-silent-skips",
    paths: [
      "web/components/nested-table-view.tsx",
      "web/components/table-view.tsx",
    ],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — nested-table-view.tsx: NestedTableView (calls a hook inside a function expression); table-view.tsx: FlatTableView (calls a hook inside a function expression).",
  },
] satisfies Exemptions;
