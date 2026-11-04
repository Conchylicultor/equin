import { z } from "zod";
import { boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { parsedJson } from "@plugins/database/plugins/sql-column/server";

// Shared columns applied to every trigger table via `defineTriggerEvent`.
// Named once here so dispatch can rely on property names (jobName, jobWith,
// oneShot, enabled, id) being stable across tables.
export const eventTriggerColumns = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  jobName: text("job_name").notNull(),
  // ONE column serving every trigger table's job-target `with` payload, so
  // there is no single closed shape to declare — and `z.record` is exactly the
  // claim `Record<string, unknown>` was making without checking it: a non-null
  // object, every key kept. It decodes on every read and every write, in the
  // ~10 `*_triggers` tables this column set builds.
  jobWith: parsedJson("job_with", z.record(z.string(), z.unknown())).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  oneShot: boolean("one_shot").notNull().default(true),
  // Written by `syncTriggerContributions` (a `Trigger` contribution's row),
  // false for a row a runtime `trigger()` call made. The boot sync owns every
  // declared row — including those of a job no longer declared (renamed or
  // removed) — so code changes reconcile them without the dangling-trigger
  // sweep ever seeing one.
  declared: boolean("declared").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
