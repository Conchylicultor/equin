import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";

import { studioApp } from "../core";
import { StudioLayout } from "./components/studio-layout";
import { Studio } from "./slots";

export { Studio } from "./slots";

export default {
  description:
    "App shell for Studio. Registers the /studio app entry and defines Studio.Sidebar/Toolbar slots.",
  contributions: [
    Apps.App({
      app: studioApp,
      component: StudioLayout,
    }),
  ],
  slots: Studio,
} satisfies PluginDefinition;
