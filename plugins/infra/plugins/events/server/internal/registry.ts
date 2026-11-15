import type { PgTable } from "drizzle-orm/pg-core";

// Module-load-time registry of per-event trigger tables. Populated by
// `defineTriggerEvent`; iterated by `deleteTrigger`, `deleteTriggersFor`, and
// event delivery (for oneShot and stale-binding cleanup) to act across every event's
// table in one sweep. Action/job registration lives in `@plugins/infra/plugins/jobs/server`.
export const triggerTableRegistry = new Map<string, PgTable>();

// Every trigger table this process has CONSTRUCTED (`defineTriggerEvent` ran),
// registered or not. A process that never runs the register phase (a test)
// still emits through these tables — an event's dispatch reads the table its
// own definition built — so this, not `triggerTableRegistry`, is the set an
// emit in that process can match rows in.
export const definedTriggerTables = new Set<PgTable>();
