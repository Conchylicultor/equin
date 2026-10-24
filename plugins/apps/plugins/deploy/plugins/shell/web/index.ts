import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";

import { deployApp } from "../core";
import { DeployLayout } from "./components/deploy-layout";

export default {
  description: "App shell for the deploy platform.",
  contributions: [
    Apps.App({
      app: deployApp,
      component: DeployLayout,
    }),
  ],
} satisfies PluginDefinition;
