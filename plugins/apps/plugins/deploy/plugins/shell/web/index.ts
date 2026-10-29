import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { ThemeEngine } from "@plugins/ui/plugins/theme-engine/web";

import { deployApp } from "../core";
import { DeployLayout } from "./components/deploy-layout";
import { deployGraphiteTheme } from "./internal/theme";
import { Deploy } from "./slots";

export { Deploy } from "./slots";

export default {
  description: "App shell for the deploy platform.",
  contributions: [
    ThemeEngine.Theme(deployGraphiteTheme),
    Apps.App({
      app: deployApp,
      component: DeployLayout,
    }),
  ],
  slots: Deploy,
} satisfies PluginDefinition;
