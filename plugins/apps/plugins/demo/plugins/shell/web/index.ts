import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { demoApp } from "../core";
import { DemoLayout } from "./components/demo-layout";

export default {
  description:
    "App shell for the Demo sandbox: registers the /demo app entry, whose one page is the Agent Manager rendered in-process on made-up data (DemoScope + AppEmbed over the agent manager's demo scenario).",
  contributions: [
    Apps.App({
      app: demoApp,
      component: DemoLayout,
    }),
  ],
} satisfies PluginDefinition;
