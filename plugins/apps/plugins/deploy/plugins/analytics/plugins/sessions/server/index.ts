import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import {
  deploymentPagesServed,
  deploymentSessionsServed,
} from "./internal/served";

export default {
  description:
    "Serves a deployment's visits (deploy-analytics.sessions) from this computer's copy of the site's analytics tables (site-mirror's replica): collect's own visit-list SQL — the window, the rows by key, the groupings and the count, each filter compiled by collect — and the paths its visits hit (deploy-analytics.pages, the Pages filter's options: a window, most visited first, searched by path), run on the copy, re-read whenever a pull applies a page to it.",
  contributions: [
    ...deploymentSessionsServed.declare,
    ...deploymentPagesServed.declare,
  ],
} satisfies ServerPluginDefinition;
