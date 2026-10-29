import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DeployRunItemActions } from "@plugins/apps/plugins/deploy/plugins/deploy-history/web";
import { RollbackAction } from "./components/rollback-action";

export default {
  description:
    "Contributes the roll-back row action to every succeeded run in a deployment's History: after a confirm, it ships that run's pinned release bundle again (`ship --release <id>`). Disabled, with the reason as its tooltip, on a run that pinned no release, on the run that is live now, and while the server is busy or unverified.",
  contributions: [
    DeployRunItemActions({
      id: "rollback",
      component: RollbackAction,
    }),
  ],
} satisfies PluginDefinition;
