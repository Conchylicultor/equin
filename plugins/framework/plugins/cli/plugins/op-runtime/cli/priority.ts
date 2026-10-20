// Admission priority — the single home for "may this op cut ahead of others?".
//
// An op whose checkout works on a SIDEQUEST task acquires its host slots at
// `low` priority: it takes a slot only while no main-track op is waiting for
// one, so the sidequest track (follow-ups the feature can ship without) never
// delays the main track (the critical path) — not its builds, checks, tests,
// e2e runs, nor its pushes queued on the push mutex. Everything else is
// `normal`: the main checkout, a main-track task, a checkout that is no
// attempt's worktree. See `Priority` (host-admission) for the mechanism.
//
// Decided when an op ACQUIRES, never inherited: a nested op spends its
// parent's grant and acquires nothing, so it has no priority to decide.

import type { Priority } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { checkoutWorktreeName } from "@plugins/infra/plugins/paths/core";
import { checkoutTrack } from "@plugins/tasks/plugins/task-track/cli";

/**
 * The priority `kind`, run from the checkout at `root`, acquires at. Reads the
 * track of the checkout's task from the main database, at acquire time — so a
 * task switched to or from the sidequest track takes effect at its next op.
 *
 * The main database not answering is said out loud and admits at `normal`:
 * priority orders the queue, it bounds nothing, so the op is no less safe for
 * it — it only stops yielding.
 */
export async function opPriority(
  root: string,
  kind: string,
  isMainCheckout: boolean,
  log: (line: string) => void = (line) => console.log(line),
): Promise<Priority> {
  if (isMainCheckout) return "normal";
  const found = await checkoutTrack(checkoutWorktreeName(root));
  switch (found.kind) {
    case "no-task":
      return "normal";
    case "unavailable":
      log(
        `Could not read this checkout's task track (${found.reason}) — the ${kind} queues at normal priority.`,
      );
      return "normal";
    case "track":
      if (found.track !== "sidequest") return "normal";
      log(
        `Sidequest task — the ${kind} queues at low priority: it takes a host slot only while no main-track op is waiting for one.`,
      );
      return "low";
  }
}
