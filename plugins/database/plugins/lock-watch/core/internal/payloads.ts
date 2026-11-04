import { z } from "zod";
import { LockHolderSchema } from "./observation";

/**
 * The jsonb payload behind a `db-lock-holder` report: one session, as the lock
 * watch saw it on the look that filed (or bumped) the row, plus the bound in
 * force — carried, never re-derived at render time.
 */
export const DbLockHolderPayloadSchema = LockHolderSchema.extend({
  thresholdMs: z.number(),
});
export type DbLockHolderPayload = z.infer<typeof DbLockHolderPayloadSchema>;
