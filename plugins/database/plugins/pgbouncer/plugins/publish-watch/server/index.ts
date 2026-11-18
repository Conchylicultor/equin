import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { GitHubEvents } from "@plugins/integrations/plugins/github-events/server";

export default {
  description:
    "Watches the daily Build and Publish workflow of equinai/pgbouncer-embedded on GitHub (GitHubEvents.Watch): a failed publish of the @equin/pgbouncer-* packages files a github-run-failed report — the next PgBouncer upgrade would have nothing to pin.",
  contributions: [
    GitHubEvents.Watch({
      repo: "equinai/pgbouncer-embedded",
      workflow: "build-and-publish.yml",
    }),
  ],
} satisfies ServerPluginDefinition;
