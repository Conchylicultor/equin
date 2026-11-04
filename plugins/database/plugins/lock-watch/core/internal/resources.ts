import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { LockWatchObservationSchema } from "./observation";

export const LockWatchStateSchema = z.object({
  /** The latest read; null until the watch has looked once since this backend started. */
  observation: LockWatchObservationSchema.nullable(),
});
export type LockWatchState = z.infer<typeof LockWatchStateSchema>;

/**
 * What the lock watch saw on its latest look at this database: who holds others
 * back, or sits idle in a transaction, RIGHT NOW. In-memory on the server (the
 * watch job runs in this backend), served external and pushed whenever a look
 * changes it. No placeholder: until the first read lands the reader renders
 * not-known-yet.
 */
export const dbLockWatch = liveValue("db-lock-watch", {
  schema: LockWatchStateSchema,
});
