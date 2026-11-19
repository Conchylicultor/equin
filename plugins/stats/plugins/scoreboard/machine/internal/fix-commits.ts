import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnExpectOk } from "@plugins/infra/plugins/spawn/core";
import { FIXES_REPORT_TRAILER } from "@plugins/reports/core";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

// Did a fix remove its problem as a class, or patch one instance? The cheapest
// honest reading git can give: a commit on main naming a report it fixes
// (`Fixes-report:`, stamped by `./equin push --fixes-report`) that ALSO changed a
// lint rule or a check (a file under a `lint/` or `check/` folder, tests aside)
// landed a guard that refuses the next one. A type-level guard or a loud runtime
// assert leaves no such trace in the paths, so this is a FLOOR on structural
// fixes, never a verdict on the rest.

const TIMEOUT_MS = 60_000;
const MARK = "@@";

/**
 * One fix as it landed: a push to main whose commits name a report they fix.
 * `./equin push --fixes-report` stamps the trailer on every commit of the
 * push, so the push — not each commit — is the unit; it landed a guard when
 * any of its commits did.
 */
export interface FixCommit {
  /** The push's newest commit's committer time, epoch ms. */
  at: number;
  guard: boolean;
}

const GUARD_PATH = /(^|\/)(lint|check)\//;
const TEST_PATH = /(\.test\.[cm]?[jt]sx?$)|(\/__tests__\/)|(\/testing\/)/;

/** Whether a changed path is a lint rule or a check (not their tests). */
export function isGuardPath(path: string): boolean {
  return GUARD_PATH.test(path) && !TEST_PATH.test(path);
}

/**
 * Parse `git log --format=@@%H %ct <push id> --name-only` output into one fix
 * per push (a commit with no push trailer is its own).
 */
export function parseFixLog(out: string): FixCommit[] {
  const pushes = new Map<string, FixCommit>();
  let current: FixCommit | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith(MARK)) {
      const [sha = "", ct, push] = line.slice(MARK.length).trim().split(" ");
      const key = push && push.length > 0 ? push : sha;
      const at = Number(ct) * 1000;
      current = pushes.get(key) ?? { at, guard: false };
      current.at = Math.max(current.at, at);
      pushes.set(key, current);
    } else if (current && line.trim() !== "" && isGuardPath(line.trim())) {
      current.guard = true;
    }
  }
  return [...pushes.values()];
}

/**
 * Every fix push on main since `sinceMs`. A `Report-fixed-by:` claim (an older
 * commit claimed later) is not counted: its fix landed before it was named.
 */
export async function readFixCommits(sinceMs: number): Promise<FixCommit[]> {
  const root = await ensureMainWorktreeRoot();
  const { stdout } = await spawnExpectOk(
    [
      GIT,
      "-C",
      root,
      "log",
      "main",
      `--since=${new Date(sinceMs).toISOString()}`,
      "--regexp-ignore-case",
      `--grep=^${FIXES_REPORT_TRAILER}:`,
      `--format=${MARK}%H %ct %(trailers:key=${LEGACY_IDS.pushTrailer},valueonly,separator=)`,
      "--name-only",
    ],
    { timeoutMs: TIMEOUT_MS },
  );
  return parseFixLog(stdout);
}
