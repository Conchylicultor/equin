import { GIT } from "@plugins/infra/plugins/paths/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";

/**
 * The newest `count` commits on main's first-parent line, newest first. The
 * film's deployed site runs one of them, so a "N commits behind" reading is a
 * real count in this repository (a run's commit subject is read from git).
 */
export async function readMainCommits(count: number): Promise<string[]> {
  const { stdout } = await spawnExpectOk(
    [
      GIT,
      "--no-optional-locks",
      "-C",
      REPO_ROOT,
      "rev-list",
      "--first-parent",
      "-n",
      String(count),
      "refs/heads/main",
    ],
    { timeoutMs: 60_000 },
  );
  return stdout.split("\n").filter((l) => l.length > 0);
}
