import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

/**
 * Where this clone's local `main` stands against the newest release upstream
 * has cut, as the web reads it.
 *
 * - `unknown`     — nobody has asked upstream yet (no check recorded), or the
 *                   only answers so far were "could not reach it". Not
 *                   "up to date": that is a claim about upstream nobody made.
 * - `no-upstream` — this checkout publishes to its own remote (the author) or
 *                   has none. There is nothing to update from.
 * - `no-release`  — upstream answered and has cut no release yet. A clone is
 *                   told about releases only, never about commits.
 * - `current`     — the newest release is in local `main`. `installed`: the
 *                   build this backend serves holds it too — false on main
 *                   between the merge landing and main's rebuild (always
 *                   true on any other checkout, which installs nothing).
 * - `behind`      — it is not. `current` is the newest release local `main`
 *                   holds (`null`: it holds none, e.g. a clone made before
 *                   releases existed); `commits`, how many commits the new
 *                   release holds that local `main` does not.
 *
 * `checkedAt` is when upstream last answered (ISO). Release names are tags
 * (`v2026.11.14`); `releaseVersion` makes them read as versions.
 */
export const ReleaseStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("no-upstream") }),
  z.object({
    kind: z.literal("no-release"),
    current: z.string().nullable(),
    checkedAt: z.string(),
  }),
  z.object({
    kind: z.literal("current"),
    current: z.string(),
    latest: z.string(),
    installed: z.boolean(),
    checkedAt: z.string(),
  }),
  z.object({
    kind: z.literal("behind"),
    current: z.string().nullable(),
    latest: z.string(),
    commits: z.number().int().nonnegative(),
    checkedAt: z.string(),
  }),
]);

export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;

/**
 * The live release status. A schema-bounded scalar, pushed: one small value,
 * the same for every tab. No placeholder — until the server has answered,
 * `useLive` reports it pending.
 *
 * Its truth is git (local `main`, the fetched release tags) plus the last
 * check's answer, so it needs the computer: a reader under an in-browser
 * server gets `unavailable`.
 */
export const upstreamReleaseStatus = liveValue("upstream.release-status", {
  schema: ReleaseStatusSchema,
  needsMachine: { feature: "Checking for updates" },
});

/**
 * Ask upstream now — the same fetch the daily job runs — and record the
 * answer, which the live value then pushes. Network work, on request only.
 *
 * The answer itself reaches the page through the live value; the response says
 * only whether upstream could be asked, since an unreachable upstream records
 * nothing (it said nothing about releases) and the person who pressed the
 * button should still learn why nothing changed.
 */
export const checkUpstreamEndpoint = defineEndpoint({
  route: "POST /api/upstream/check",
  response: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("checked") }),
    z.object({ kind: z.literal("unreachable"), detail: z.string() }),
  ]),
  needsMachine: { feature: "Checking for updates" },
});
