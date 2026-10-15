import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Home } from "@plugins/apps/plugins/home/plugins/shell/web";
import { AppGrid } from "./components/app-grid";

export default {
  description:
    "Launcher grid of one card per installed app (a DataView of the installedApp row kind; plugins add fields to it as client fields of that kind), plus the new-app placeholder.",
  contributions: [
    Home.Section({ id: "apps", label: "Apps", component: AppGrid }),
  ],
} satisfies PluginDefinition;
