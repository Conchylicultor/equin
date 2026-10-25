import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { PluginViewSlots } from "@plugins/plugin-meta/plugins/plugin-view/web";
import {
  DeploySecretsCount,
  DeploySecretsDetailSection,
  useDeploySecretsAvailable,
} from "./components/deploy-secrets-detail-section";

export default {
  description: "Per-plugin deploy-secrets section in the plugin detail pane.",
  contributions: [
    PluginViewSlots.Section({
      id: "deploy-secrets",
      label: "Deploy secrets",
      component: DeploySecretsDetailSection,
      summary: DeploySecretsCount,
      useAvailable: useDeploySecretsAvailable,
    }),
  ],
} satisfies PluginDefinition;
