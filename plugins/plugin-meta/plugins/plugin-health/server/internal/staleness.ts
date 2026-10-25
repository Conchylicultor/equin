import { GIT } from "@plugins/infra/plugins/paths/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  asFsPath,
  asPluginId,
} from "@plugins/framework/plugins/plugin-id/core";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import { pluginStaleness, type PluginStaleness } from "../../shared/schemas";

// Both reads walk history for one plugin path, on an open plugin-health pane.
// Real work, but seconds of it at most; a minute is the point past which the
// pane has given up on an answer anyway.
const GIT_TIMEOUT_MS = 60_000;

/** A full or abbreviated hex sha — the only shape passed to `git` as argv. */
const SHA_RE = /^[0-9a-f]{7,40}$/;

async function git(args: string[]) {
  const cwd = await ensureMainWorktreeRoot();
  const result = await spawnCaptured([GIT, "--no-optional-locks", ...args], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.timedOut) {
    throw new Error(
      `git ${args[0]} timed out after ${GIT_TIMEOUT_MS} ms in ${cwd}`,
    );
  }
  return result;
}

async function loadStaleness(
  pluginId: string,
  commitHash: string,
): Promise<PluginStaleness> {
  if (!SHA_RE.test(commitHash)) {
    throw pluginStaleness.refuse(
      "invalid-commit",
      `The review's commit ${JSON.stringify(commitHash)} is not a hex sha`,
    );
  }
  // Refused only when git answers that the commit is not one it holds (the
  // probe's exit 1, `--quiet`): that is an answer about the stored commit. Any
  // other failure — of the probe or of a walk (a lock, a checkout mid-move, a
  // corrupt ref) — is a failing read, thrown and reported.
  const probe = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    `${commitHash}^{commit}`,
  ]);
  if (probe.exitCode === 1) {
    throw pluginStaleness.refuse(
      "unknown-commit",
      `git cannot place the review's commit ${commitHash} in main's checkout`,
    );
  }
  if (probe.exitCode !== 0) {
    throw new Error(
      `git rev-parse --verify ${commitHash} exited ${probe.exitCode}: ${probe.stderr.trim()}`,
    );
  }
  const pluginPath = asFsPath(asPluginId(pluginId));
  const [count, diff] = await Promise.all([
    git([
      "rev-list",
      "--count",
      `${commitHash}..HEAD`,
      "--",
      `plugins/${pluginPath}`,
    ]),
    git([
      "diff",
      "--name-only",
      commitHash,
      "HEAD",
      "--",
      `plugins/${pluginPath}/web/index.ts`,
      `plugins/${pluginPath}/server/index.ts`,
      `plugins/${pluginPath}/core/index.ts`,
    ]),
  ]);
  for (const [name, r] of [
    ["rev-list", count],
    ["diff", diff],
  ] as const) {
    if (r.exitCode !== 0) {
      throw new Error(
        `git ${name} from ${commitHash} exited ${r.exitCode}: ${r.stderr.trim()}`,
      );
    }
  }
  const commitsSince = Number.parseInt(count.stdout.trim(), 10);
  if (!Number.isFinite(commitsSince)) {
    throw new Error(
      `git rev-list --count answered ${JSON.stringify(count.stdout)}, not a count`,
    );
  }
  return { commitsSince, apiChanged: diff.stdout.trim().length > 0 };
}

/**
 * External: the truth is git in main's checkout (two walks, no Postgres). The
 * walk ends at main's HEAD, so the answer moves only when a tracked ref
 * advances — every subscribed tuple recomputes on `refHeadServed`, the same
 * edge `build.chain-from` rides.
 */
export const pluginStalenessServed = serveValue(pluginStaleness, {
  source: "external",
  changes: "notified",
  recomputeOn: [refHeadServed],
  loader: ({ pluginId, commitHash }) => loadStaleness(pluginId, commitHash),
});
