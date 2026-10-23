import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { markHintSeenEndpoint, resetHintsEndpoint } from "../core";
import { handleMarkHintSeen, handleResetHints } from "./internal/routes";
import { hintsSeenServed } from "./internal/resource";

export default {
  portable: true,
  description:
    "Owns the hint_seen table — one row per hint or tour the user has met (outcome, seen_at) — served as the hints.seen live collection (boot-preloaded), with the mark-seen upsert and the reset-by-ids delete.",
  httpRoutes: {
    [markHintSeenEndpoint.route]: handleMarkHintSeen,
    [resetHintsEndpoint.route]: handleResetHints,
  },
  contributions: [...hintsSeenServed.declare],
} satisfies ServerPluginDefinition;
