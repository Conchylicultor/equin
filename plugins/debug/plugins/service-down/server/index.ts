import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { serviceDownKind } from "./internal/service-down-kind";

export default {
  description:
    "The service-down report kind — filed by the gateway's watchdog through the report outbox when a supervised service (embedded Postgres, PgBouncer, any database.json service) stops answering mid-session, once the outage settles, drained by main: the probe and its error, how long it had been up, whether the re-start brought it back, the start command's output and the service's last log lines.",
  contributions: [serviceDownKind],
} satisfies ServerPluginDefinition;
