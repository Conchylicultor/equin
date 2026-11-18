import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { releaseWorkflowWatch } from "./internal/watch";

export default {
  description:
    "Watches the release workflow on GitHub (GitHubEvents.Watch: the product repo's installer-release.yml and its Releases), so a failed release run files a report naming the re-publish command, and the releases row reads what GitHub published.",
  contributions: [releaseWorkflowWatch],
} satisfies ServerPluginDefinition;
