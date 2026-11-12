import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { recordsWriteLostKind } from "./internal/kind";

export default {
  description:
    "plugin-records-write-lost report kind: validates the shared record store's lost-write payloads (filed through the report outbox by the store itself, one row per cause) and renders a task naming the process, the records lost and how its writes waited in the writer line and held the lock. Warning, re-arms daily.",
  contributions: [recordsWriteLostKind],
} satisfies ServerPluginDefinition;
