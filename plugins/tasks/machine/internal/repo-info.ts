import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { GIT } from "@plugins/infra/plugins/paths/server";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { repoInfo } from "../../core";

// `git remote get-url` reads one config line — no network despite the name.
// Thirty seconds is only ever reached by a wedge.
const GIT_TIMEOUT_MS = 30_000;

function parseGithubBase(remote: string): string | null {
  const trimmed = remote.trim();
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const https = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
  );
  if (https) return `https://github.com/${https[1]}/${https[2]}`;
  return null;
}

async function loadRepoInfo(): Promise<{ githubBase: string | null }> {
  const cwd = await ensureMainWorktreeRoot();
  const result = await spawnCaptured([GIT, "remote", "get-url", "origin"], {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  // A non-zero exit is "no such remote": a repo with no `origin` has no
  // GitHub base, which is an answer, not a failure.
  if (result.exitCode !== 0) return { githubBase: null };
  return { githubBase: parseGithubBase(result.stdout) };
}

// External: the truth is the repo's git config, which no change feed sees.
// A snapshot, re-read on each mount: the remote CAN move under a running server
// (`git remote set-url`, a clone renaming `origin`), so `fixed` would overclaim,
// but the only signal for it is a watch on the main checkout's common git dir —
// the high-churn store every linked worktree writes (objects, index, HEAD,
// logs), which the dir hub would open as one native RECURSIVE watch, waking
// this backend on every commit and fetch across the machine to discard all but
// `config`. git-watcher refuses that watch for the same reason.
export const repoInfoServed = serveValue(repoInfo, {
  source: "external",
  changes: {
    snapshot: {
      reason:
        "the git config's only change signal is a recursive watch on the shared common git dir, too costly for a rarely-moved remote",
    },
  },
  loader: loadRepoInfo,
});
