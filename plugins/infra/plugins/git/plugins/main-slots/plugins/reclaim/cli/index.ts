import { defineCliCommand } from "@plugins/framework/plugins/cli/core";

/**
 * The body of the daily `main-slots.reclaim` job (main-slots' `server/`),
 * which runs it as its supervised child's argv. A command rather than a
 * `run` body so the reclaim (git, the worktree gate, the outbox) stays in the
 * CLI's closure, never the serving backend's.
 *
 * `detachable`: a supervised child is spawned detached, and the orphan guard
 * would otherwise exit it the moment it found no invoking shell.
 */
export default defineCliCommand<[], Record<string, never>>({
  name: "main-slots-reclaim",
  description:
    "Reclaim main's slot pool: stamp slots no app lives in, report processes that kept one busy past the drain threshold, remove free slots beyond the one kept ready (what the daily main-slots.reclaim job runs; every main build ends with it too)",
  detachable: true,
  run: () => import("./run"),
});
