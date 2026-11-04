import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  MAX_CONNECTIONS,
  PG_DATA_DIR,
  PG_DIR,
  PG_LOG_FILE,
  PG_PORT,
  PG_SERVICE_NAME,
  PG_SOCKET_DIR,
  PG_USER,
  pgPostmasterPidFile,
} from "../shared";

// Server side has nothing to register — the embedded PG cluster is owned
// by the gateway. We only ship a server barrel so sibling plugins can
// import paths from `@plugins/database/plugins/embedded/server` (the standard
// cross-plugin grammar).
export default {
  description:
    "Embedded Postgres binaries for the gateway-owned cluster. Provides shared connection constants used by every worktree backend.",
  loadBearing: true,
} satisfies ServerPluginDefinition;
