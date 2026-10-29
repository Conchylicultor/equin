import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";

/**
 * What one deployment is running, against `main`.
 *
 * - `known` — `sha` is the commit the newest succeeded shipping run (`ship` /
 *   `update`) recorded for its bundle, `subject` its subject line, and
 *   `behindMain` the commits on the `main` ref (`refs/heads/main`, never this
 *   checkout's HEAD) that `sha` does not contain — 0 when it is up to date,
 *   whether or not it is itself on main. `mainSha` is the main tip the count
 *   was taken against.
 * - `unknown` — the question has no honest answer, and `reason` says why in a
 *   sentence: nothing has shipped yet, the run that did recorded no commit, or
 *   this repository has never seen it. Never a stand-in sha or a zero count.
 */
export const RunningCommitSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("known"),
    sha: z.string(),
    subject: z.string(),
    behindMain: z.number().int().nonnegative(),
    mainSha: z.string(),
  }),
  z.object({ kind: z.literal("unknown"), reason: z.string() }),
]);
export type RunningCommit = z.infer<typeof RunningCommitSchema>;

/**
 * The commit a deployment is running and how far behind `main` it is — the
 * "Behind main" banner, the Deploy button's commit count, the Bundle cell and
 * check. Pushed: it moves when a run lands (the `deploy_runs` change feed) or
 * `main` advances (the git ref watcher), and on nothing else.
 */
export const runningCommit = liveValue("deploy.running-commit", {
  schema: RunningCommitSchema,
  params: ["deploymentId"],
});
