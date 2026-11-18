import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The body of the daily `source-digest.prune` job (`../server`), which runs it
 * as its supervised child's argv. A command rather than a `run` body so the
 * facts store's prune (bun:sqlite) stays in the CLI's closure, never the
 * serving backend's.
 *
 * `detachable`: a supervised child is spawned detached, and the orphan guard
 * would otherwise exit it the moment it found no invoking shell.
 */
export default defineCliCommand({
  name: "source-facts-prune",
  description:
    "Prune the shared source-digest facts store: delete rows unread for 14 days, a page at a time (what the daily source-digest.prune job runs)",
  detachable: true,
  run: () => import("./run"),
});
