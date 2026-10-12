import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ExcludeFromFork } from "@plugins/database/plugins/admin/server";
import { _bootTraces } from "./internal/tables";
import { saveBootTrace } from "../shared/endpoints";
import { handleSaveBootTrace } from "./internal/handlers";
import { bootTraceServed, bootTracesServed } from "./internal/resources";
import { bootTraceRetention } from "./internal/retention";

export { _bootTraces } from "./internal/tables";

export default {
  description:
    "Persists captured browser boot traces under a unique id (POST), serves the debug.boot-traces metadata-only list and the debug.boot-trace by-id lookup (live collections) for the browse + permalink panes, and sweeps snapshots older than 30 days via a scheduled job.",
  httpRoutes: {
    [saveBootTrace.route]: handleSaveBootTrace,
  },
  contributions: [
    ...bootTracesServed.declare,
    ...bootTraceServed.declare,
    // A saved boot trace is a permalink someone minted by clicking "copy link"
    // in one browser tab against one backend. The id only means anything to the
    // database that issued it, so a fork inherits URLs nobody will ever open.
    ExcludeFromFork({
      table: _bootTraces,
      reason:
        "Host-local boot-profile permalinks; the ids are only meaningful to the database that issued them.",
    }),
  ],
  register: [bootTraceRetention],
} satisfies ServerPluginDefinition;
