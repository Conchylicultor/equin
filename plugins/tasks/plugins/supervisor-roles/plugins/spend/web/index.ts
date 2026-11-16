import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { SupervisorsList } from "@plugins/tasks/plugins/supervisor-roles/plugins/pane/web";
import { supervisorsSpendPane } from "./panes";
import { SpendGlance } from "./components/spend-glance";
import { SpendRowActions, spendRowActions } from "./components/spend-detail";

export default {
  description:
    "The supervisors spend breakdown, web half: the Spent this week glance atop the Supervisors list (the total, the categories as a thin bar and a legend; a segment or an entry opens its category) and the breakdown pane (/agents/supervisors/spend/<path>): one level at a time, the title its path, the total counting to each level's, the bar zooming into the picked part, the rows (a DataView) cross-fading, Esc going up; a conversation's row opens it in a new pane. Each account counts from its own weekly reset (an API-key account, or one with no usage reading, over the last 7 days); usage counted under no account, from the earliest of them.",
  contributions: [
    Pane.Register({ pane: supervisorsSpendPane }),
    SupervisorsList.Head({
      id: "spend",
      label: "Spent this week",
      component: SpendGlance,
    }),
    ...spendRowActions,
  ],
  slots: {
    "supervisors-spend": supervisorsSpendPane,
    "row-actions": SpendRowActions,
  },
} satisfies PluginDefinition;
