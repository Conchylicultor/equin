import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mainDeployFailedKind } from "./internal/main-deploy-failed-kind";

export default {
  description:
    "The main-deploy-failed report kind — filed by the gateway through the report outbox when main's convergence run (`./equin build --allow-main --converge`) fails to decide or start a build, drained by main once it is up: how it ended, what started it, and its last lines.",
  contributions: [mainDeployFailedKind],
} satisfies ServerPluginDefinition;
