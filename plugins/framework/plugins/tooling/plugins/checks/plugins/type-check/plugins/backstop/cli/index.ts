import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The body of the daily `type-check.backstop` job (`../server`), which runs
 * it as its supervised child's argv. A command rather than a `run` body so the
 * check runner's barrel and the type-check worker plumbing stay in the CLI's
 * closure, never the serving backend's (`boot:closure-digestable`).
 *
 * `detachable`: a supervised child is spawned detached, and the orphan guard
 * would otherwise exit it the moment it found no invoking shell.
 */
export default defineCliCommand({
  name: "type-check-backstop",
  description:
    "Run the two-program type check beside a full check of a fresh program on this checkout and file a report for every file where they disagree (what the daily type-check.backstop job runs)",
  detachable: true,
  run: () => import("./run"),
});
