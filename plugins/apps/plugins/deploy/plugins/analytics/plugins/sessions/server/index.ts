import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { deploymentSessionsServed } from "./internal/served";

export default {
  description:
    "Serves a deployment's visits (deploy-analytics.sessions) from this computer's copy of the site's analytics tables (site-mirror's replica): collect's own visit-list SQL — the window, the rows by key, the groupings and the count, each filter compiled by collect — run on the copy, re-read whenever a pull applies a page to it.",
  contributions: [...deploymentSessionsServed.declare],
} satisfies ServerPluginDefinition;
