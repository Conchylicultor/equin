import type { Exemptions } from "@plugins/framework/plugins/tooling/plugins/exempt/core";

export default [
  {
    rule: "spacer/no-split-slot-row",
    paths: ["web/components/browser-layout.tsx"],
    kind: "sanctioned",
    reason:
      "The browser toolbar's three slots (nav controls, the omnibox, actions) are different kinds of thing: the omnibox is a single growing occupant, not a movable item among the buttons.",
  },
  {
    rule: "react-compiler:no-silent-skips",
    paths: ["web/components/persist-tabs.tsx"],
    kind: "debt",
    task: "task-1795087496-4w8ni5",
    reason:
      "Left uncompiled by the React Compiler — PersistBrowserTabs (unsupported syntax: Handle TryStatement without a catch clause).",
  },
] satisfies Exemptions;
