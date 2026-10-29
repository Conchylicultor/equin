import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DeploymentDetail } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { CompositionSection } from "./components/composition-section";

export default {
  description:
    "Composition section of the site page's Settings tab: which composition this deployment builds and ships, the shape of it (category, entry points, what it extends, how many contributors are opted in), and a cross-app link into that composition's Studio detail pane where its membership is actually edited.",
  contributions: [
    DeploymentDetail.Section({
      id: "composition",
      label: "Composition",
      component: CompositionSection,
      useDefaultOpen: () => true,
    }),
  ],
} satisfies PluginDefinition;
