import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The body of the hourly `web-artifacts.prune` job (`../server`), which runs
 * it as its supervised child's argv. A command rather than a `run` body so the
 * web-artifact builder's barrel stays in the CLI's closure, never the serving
 * backend's (`boot:closure-digestable`).
 *
 * `detachable`: a supervised child is spawned detached, and the orphan guard
 * would otherwise exit it the moment it found no invoking shell.
 */
export default defineCliCommand({
  name: "web-artifacts-prune",
  description:
    "Prune the shared write-once web caches no served dist links (what the hourly web-artifacts.prune job runs)",
  detachable: true,
  run: () => import("./run"),
});
