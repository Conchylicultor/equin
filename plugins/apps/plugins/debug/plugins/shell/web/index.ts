import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";

import { debugApp } from "../core";
import { DebugLayout } from "./components/debug-layout";
import { DebugApp } from "./slots";

export { DebugApp } from "./slots";

export default {
  description:
    "App shell for the debug tools. Registers the /debug app entry and defines DebugApp.Sidebar/Toolbar slots.",
  contributions: [
    Apps.App({
      app: debugApp,
      component: DebugLayout,
    }),
  ],
  slots: DebugApp,
} satisfies PluginDefinition;
