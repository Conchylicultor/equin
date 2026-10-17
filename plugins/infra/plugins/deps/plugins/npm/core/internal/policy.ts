// The `dependencyPolicy` a workspace package.json may carry, next to the
// dependencies it constrains. It replaces the exact pin: a spec is always a
// range, the lock is what fixes a version, and the npm updater is what moves the
// lock — so the only things left to declare are the two reasons a move must be
// shaped (a lockstep group) or waited for (a hold — the shared bounded `Hold` of
// infra/deps/updates, the same model the mise and uv updaters use).

import { z } from "zod";
import { HoldSchema } from "@plugins/infra/plugins/deps/plugins/updates/core";

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

export const PolicySchema = z
  .object({
    groups: z.array(GroupSchema).optional(),
    holds: z.array(HoldSchema).optional(),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;
