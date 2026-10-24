import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";

// Per-database active/total Postgres backend counts. `active` is the count of
// backends in the `active` state (running a query right now); `pgTopDatabases`
// keeps the few highest-`active` databases so a storm points at its hottest DB.
export const ContentionTopDatabaseSchema = z.object({
  datname: z.string(),
  active: z.number(),
});
export type ContentionTopDatabase = z.infer<typeof ContentionTopDatabaseSchema>;

// A point-in-time snapshot of cross-process system contention: the OS load
// average (every process on the box, incl. all git subprocesses) and the
// cluster-wide Postgres backend counts (every DB client across all worktree
// forks — pg_stat_activity is a cluster-global view). These are the two honest
// signals an in-process counter can't see. Stamped onto a slow-op the instant a
// span trips its threshold so "edited-files took 13s" becomes "…while the box
// was at load 38 (12 cores) with 47 active Postgres backends cluster-wide."
export const ContentionSnapshotSchema = z.object({
  atTime: z.coerce.date(),
  loadAvg1: z.number(),
  loadAvg5: z.number(),
  loadAvg15: z.number(),
  cpuCount: z.number(),
  pgActiveBackends: z.number(),
  pgTotalBackends: z.number(),
  pgTopDatabases: wholeList(ContentionTopDatabaseSchema, {
    reason: "the few highest-active databases the snapshot keeps",
  }),
});
export type ContentionSnapshot = z.infer<typeof ContentionSnapshotSchema>;
