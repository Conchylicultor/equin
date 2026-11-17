import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  getMainRepoRoot,
  spawnExpectOk,
  spawnPassthrough,
} from "@plugins/infra/plugins/spawn/core";
import { runInBuildSlot } from "@plugins/infra/plugins/git/plugins/main-slots/cli";
import { CLI_NAME } from "@plugins/framework/plugins/cli/plugins/cli-name/core";
import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/** What the relay touches outside itself — the real ones by default, fakes in its test. */
export interface SlotRelayDeps {
  /** The repo's git store (refs, worktrees) for a checkout of it. */
  mainRepoRoot: (root: AppPath) => Promise<AppPath>;
  /** The commit `refs/heads/main` names in that store. */
  mainHead: (repoRoot: AppPath) => Promise<string>;
  /** `runInBuildSlot` (`infra/git/main-slots`). */
  runInBuildSlot: typeof runInBuildSlot;
  /** Run the child build, output inherited; its exit code. */
  spawn: (
    argv: string[],
    opts: { cwd: AppPath; env: Record<string, string | undefined> },
  ) => Promise<number>;
  /** This invocation's own arguments (after `bun <entry>`). */
  args: string[];
  /** This invocation's own environment. */
  env: Record<string, string | undefined>;
  log: (line: string) => void;
}

const defaultDeps = (): SlotRelayDeps => ({
  mainRepoRoot: (root) => getMainRepoRoot(root),
  mainHead: async (repoRoot) =>
    (
      await spawnExpectOk(["git", "rev-parse", "--verify", "refs/heads/main"], {
        cwd: repoRoot,
        timeoutMs: 60_000,
      })
    ).stdout.trim(),
  runInBuildSlot,
  spawn: async (argv, opts) => (await spawnPassthrough(argv, opts)).exitCode,
  args: process.argv.slice(2),
  env: process.env,
  log: (line) => console.log(line),
});

/**
 * A main build that was not handed a slot, re-run in one: a slot checked out
 * at `refs/heads/main` (the commit main's convergence would build), handed to
 * `<slot>/equin build` with this invocation's own arguments and environment
 * (its `BUILD_ID` — the row its claimer minted, the transcript it writes to),
 * output inherited (this process is already that run's transcript). Returns
 * the child's exit code, which this process exits with.
 *
 * The one route a main build takes into a slot besides the convergence run's
 * own (`converge.ts`, the same `runInBuildSlot`): the Build button's build
 * runs in the checkout its backend serves from, and a hand-run one in the
 * repo root — neither may build where it stands.
 */
export async function relayIntoSlot(
  root: string,
  deps: SlotRelayDeps = defaultDeps(),
): Promise<number> {
  const repoRoot = await deps.mainRepoRoot(asAppPath(root));
  const sha = await deps.mainHead(repoRoot);
  deps.log(
    `Main builds in a slot: building refs/heads/main (${sha.slice(0, 9)}) in one, not in ${root}.`,
  );
  return deps.runInBuildSlot(
    sha,
    { repoRoot, label: readEnv("BUILD_ID", deps.env) ?? "build" },
    async ({ slot, created, env }) => {
      deps.log(`Slot ${slot} (${created ? "made" : "reused"}).`);
      return deps.spawn([joinAppPath(slot, CLI_NAME), ...deps.args], {
        cwd: slot,
        env: { ...deps.env, ...env },
      });
    },
  );
}
