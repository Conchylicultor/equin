import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  PGBOUNCER_PORT,
  PGBOUNCER_SOCKET_DIR,
  PGBOUNCER_LOG_FILE,
  PGBOUNCER_SERVICE_NAME,
  pgbouncerPidFileUnder,
} from "../shared";
export { pgbouncerConfigFiles } from "./internal/config";

export default {
  description:
    "PgBouncer connection pooler for the embedded Postgres cluster: path constants for connection routing, and this machine's config rendered from the lane table (one server pool per connection lane).",
  loadBearing: true,
} satisfies ServerPluginDefinition;
