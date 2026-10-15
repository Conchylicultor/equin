import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { CompositionDetail } from "@plugins/apps/plugins/studio/plugins/compositions/web";
import { HomeSection } from "./components/home-section";

export default {
  description:
    "Home app section of the Studio composition detail pane: picks the app that owns bare `/` when the composition is deployed, among the apps its bundle holds.",
  contributions: [
    CompositionDetail.Section({
      id: "home",
      label: "Home app",
      component: HomeSection,
    }),
  ],
} satisfies PluginDefinition;
