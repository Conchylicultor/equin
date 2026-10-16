// The `dependencyPolicy` a workspace package.json may carry, next to the
// dependencies it constrains. It replaces the exact pin: a spec is always a
// range, the lock is what fixes a version, and the npm updater is what moves the
// lock — so the only things left to declare are the two reasons a move must be
// shaped (a lockstep group) or waited for (a hold).

import { z } from "zod";

/** The longest a hold may be set for, from the day it is set or renewed. */
export const HOLD_MAX_DAYS = 90;

/** The package.json key. */
export const POLICY_KEY = "dependencyPolicy";

/**
 * Which part of the version every member of a group shares: `version` (the
 * same release — a platform-binary quartet, a library family whose types must
 * be one copy), `major.minor` or `major` (different packages built from one
 * upstream release, e.g. a server and its client tools).
 */
export const AGREE = ["version", "major.minor", "major"] as const;
export type Agree = (typeof AGREE)[number];

/**
 * Packages that move together. They never stop moving: the updater moves the
 * group as one, to the newest releases on which every member agrees. When one
 * member has published a release its partners have not, the move is BLOCKED and
 * the upgrade task asks for `prerequisite` (or, without one, waits for upstream).
 */
export const GroupSchema = z
  .object({
    id: z.string().min(1),
    members: z.array(z.string().min(1)).min(2),
    agree: z.enum(AGREE),
    reason: z.string().min(1),
    prerequisite: z.string().min(1).optional(),
  })
  .strict();
export type Group = z.infer<typeof GroupSchema>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Releases not to land yet: one broken `version`, or everything from `below` up.
 * Always bounded: `until` is a day at most {@link HOLD_MAX_DAYS} out when the
 * hold is set (the `deps-npm:policy` check), and on that day the hold goes
 * inert — the updater proposes the move again and the gates decide. Keeping it
 * longer is a renewal: a new `until` and reason, in a reviewed diff.
 */
export const HoldSchema = z
  .object({
    packages: z.array(z.string().min(1)).min(1),
    version: z.string().min(1).optional(),
    below: z.string().min(1).optional(),
    reason: z.string().min(1),
    issue: z.string().url().optional(),
    until: z.string().regex(DAY, "a YYYY-MM-DD day"),
  })
  .strict()
  .refine((h) => (h.version === undefined) !== (h.below === undefined), {
    message: "a hold names exactly one of `version` or `below`",
  });
export type Hold = z.infer<typeof HoldSchema>;

export const PolicySchema = z
  .object({
    groups: z.array(GroupSchema).optional(),
    holds: z.array(HoldSchema).optional(),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

/** `YYYY-MM-DD` of `now`, UTC — the day a hold's `until` is compared with. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whether `hold` is honoured on `today`: through its `until` day, inclusive. */
export function holdActive(hold: Hold, today: string): boolean {
  return hold.until >= today;
}

/** The latest `until` a hold set or renewed on `today` may carry. */
export function latestUntil(today: string): string {
  const t = Date.parse(`${today}T00:00:00Z`) + HOLD_MAX_DAYS * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
