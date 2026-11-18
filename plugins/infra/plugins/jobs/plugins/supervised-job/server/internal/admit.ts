import {
  inheritedGrant,
  withHostGrant,
} from "@plugins/infra/plugins/host/plugins/host-admission/server";
import type {
  GrantHooks,
  Lane,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  getMainRepoRoot,
  getWorktreeRoot,
} from "@plugins/infra/plugins/spawn/core";

/**
 * The host admission an `ExecContext` carries: one unit of the `cpu` pool in
 * `lane`, so whatever runs under it (a dependency install, a dataset
 * download) is bounded with the rest of the fleet.
 *
 * A process that INHERITED a grant (`EQUIN_HOST_GRANT`, set by a holder
 * for the subprocess it spawns — `./equin deps install` run by a check
 * inside a build) spends one of those units instead: the grant contract is that
 * nothing a holder spawns re-acquires host-wide. Acquiring anyway waited on the
 * parent's own slots — on a host whose whole fleet is one unit (an 8 GB box:
 * `B = 1`), for ever, since the parent was waiting on this child.
 */
function admitIn(lane: Lane, hooks?: GrantHooks) {
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const inherited = inheritedGrant();
    if (inherited) return inherited.run(fn);
    return withHostGrant(
      {
        lane,
        priority: "normal",
        max: 1,
        work: "job",
        ...(hooks === undefined ? {} : { hooks }),
      },
      () => fn(),
    );
  };
}

/**
 * A supervised job's admission (`run-body.ts`): background — nobody is
 * blocked on a job, so it yields to builds and interactive work.
 */
export const admitBackground = admitIn("background");

/**
 * A `./equin` CLI command's admission (`cliExecContext`, which reaches this
 * file through a deferred import so the `cli` declaration stays light): the
 * lane of whoever runs the command — an ancestor's published `EQUIN_LANE`
 * if there is one (an op, or the grant it handed down); else interactive
 * when a person runs it in the main checkout (`interactiveCaller`); else
 * background.
 *
 * Not always background: a person re-running install.sh or `./equin start`
 * on main is waiting on its dependency installs, and the background lane can
 * be the one with no free slot (2026-11-16 onboarding audit: a 16 GB Mac's
 * measured window kept its one slot for interactive work).
 */
export async function admitForCaller<T>(
  fn: () => Promise<T>,
  hooks?: GrantHooks,
): Promise<T> {
  return admitIn(await callerLane(), hooks)(fn);
}

async function callerLane(): Promise<Lane> {
  const published = readEnv("LANE");
  if (published === "interactive" || published === "background")
    return published;
  return (await interactiveCaller()) ? "interactive" : "background";
}

/**
 * Is a person waiting on this command? It runs in a repository's main
 * checkout (agents work in linked worktrees) AND writes to a terminal. The
 * terminal half is what keeps main's own unattended commands background: a
 * scheduled job's CLI child (the blocker scan, a supervised run), a login
 * service — run from the main checkout, but with nobody at the other end.
 *
 * "Main checkout of its repository" is git's answer alone (the worktree root
 * is the main repo root), not `checkoutRef`'s: which clone this data root
 * serves is a question about namespaces, and a lane needs only "is this an
 * agent's worktree".
 */
async function interactiveCaller(): Promise<boolean> {
  if (!process.stderr.isTTY) return false;
  const [root, mainRoot] = await Promise.all([
    getWorktreeRoot(),
    getMainRepoRoot(),
  ]);
  return root === mainRoot;
}
