import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { MenuBar } from "@plugins/menu-bar/web";
import { MenuBarTaskField } from "./components/task-field";

export default {
  description:
    "The menu-bar panel's task field (MenuBar.Section 'task'): an autogrowing textarea (up to six lines, then it scrolls) — Enter files the text as one top-level task through the task-draft form's submitChain (POST /api/tasks/chain) with every launch option at its default, so auto-start behaves as in Improve; Shift+Enter adds a line, Escape clears. The field confirms inline ('Filed — …') or shows why the submit failed.",
  contributions: [
    MenuBar.Section({ id: "task", label: "Task", component: MenuBarTaskField }),
  ],
} satisfies PluginDefinition;
