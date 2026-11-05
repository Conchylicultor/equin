import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The body of the hourly `checks.cache-prune` job (`../server`), which runs
 * it as its supervised child's argv. A command rather than a `run` body so the
 * check runner's barrel — the whole check registry — stays in the CLI's
 * closure, never the serving backend's (`boot:closure-digestable`).
 *
 * `detachable`: a supervised child is spawned detached, and the orphan guard
 * would otherwise exit it the moment it found no invoking shell.
 */
export default defineCliCommand({
  name: "check-cache-prune",
  description:
    "Age out and cap the shared check-result cache and reclaim idle flight files (what the hourly checks.cache-prune job runs)",
  detachable: true,
  run: () => import("./run"),
});
