import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The body of the daily `plugin-records.reclaim` job (`../server`), which runs
 * it as its supervised child's argv. A command rather than a `run` body so the
 * record store (bun:sqlite) stays in the CLI's closure, never the serving
 * backend's (`boot:closure-digestable`).
 *
 * `detachable`: a supervised child is spawned detached, and the orphan guard
 * would otherwise exit it the moment it found no invoking shell.
 */
export default defineCliCommand({
  name: "plugin-records-reclaim",
  description:
    "Reclaim the shared plugin-record store: delete key rows unread for 7 days and the values only they named, then return the freed pages (what the daily plugin-records.reclaim job runs)",
  detachable: true,
  run: () => import("./run"),
});
