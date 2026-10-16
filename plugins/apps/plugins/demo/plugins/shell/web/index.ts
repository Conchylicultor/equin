import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { appIcon } from "@plugins/apps-core/plugins/app-icon/core";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { demoApp } from "../core";
import { DemoLayout } from "./components/demo-layout";

export default {
  description:
    "App shell for the Demo sandbox: registers the /demo app entry, whose one page is the Agent Manager rendered in-process on made-up data (DemoScope + AppEmbed over the agent manager's demo scenario).",
  contributions: [
    Apps.App({
      app: demoApp,
      icon: appIcon(symbol("smart-display")),
      component: DemoLayout,
    }),
  ],
} satisfies PluginDefinition;
