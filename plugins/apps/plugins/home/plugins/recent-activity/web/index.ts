import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Home } from "@plugins/apps/plugins/home/plugins/shell/web";
import { RecentActivity } from "./components/recent-activity";

export default {
  description:
    "Home's Recent activity section: tasks, conversations and pages in one list, newest activity first (the activity Meta-DataView), each row opening its record in its own app.",
  contributions: [
    Home.Section({
      id: "recent-activity",
      label: "Recent activity",
      component: RecentActivity,
    }),
  ],
} satisfies PluginDefinition;
