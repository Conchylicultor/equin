import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The body of the daily `checks.grep-index-prune` job (`../server`), which
 * runs it as its supervised child's argv. A command rather than a `run` body
 * so the check runner's barrel stays in the CLI's closure, never the serving
 * backend's (`boot:closure-digestable`).
 *
 * `detachable`: a supervised child is spawned detached, and the orphan guard
 * would otherwise exit it the moment it found no invoking shell.
 */
export default defineCliCommand({
  name: "check-grep-index-prune",
  description:
    "Prune the shared grep index of the grep-based checks: delete rows unread for 14 days, a page at a time (what the daily checks.grep-index-prune job runs)",
  detachable: true,
  run: () => import("./run"),
});
