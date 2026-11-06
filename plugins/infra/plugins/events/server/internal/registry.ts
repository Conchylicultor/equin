import type { PgTable } from "drizzle-orm/pg-core";

// Module-load-time registry of per-event trigger tables. Populated by
// `defineTriggerEvent`; iterated by `deleteTrigger`, `deleteTriggersFor`, and
// event delivery (for oneShot and stale-binding cleanup) to act across every event's
// table in one sweep. Action/job registration lives in `@plugins/infra/plugins/jobs/server`.
export const triggerTableRegistry = new Map<string, PgTable>();
