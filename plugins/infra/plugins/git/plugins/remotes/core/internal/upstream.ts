import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  remoteUrl,
  resolvePublishTarget,
  PUBLISH_REMOTE,
} from "./publish-target";
import { sameRepoUrl } from "./remote-url";
import { SOURCE_REPO_URL } from "@plugins/framework/plugins/product-name/core";
import type { UpstreamRemote } from "./types";

/** The remote name a fork's upstream is added under — git's own convention. */
const UPSTREAM_REMOTE = "upstream";

const REMOTE_ADD_TIMEOUT_MS = 60_000;

/**
 * Which remote does this checkout RECEIVE from?
 *
 * Read off the same facts as `resolvePublishTarget`, in this order:
 *
 * 1. a remote literally named `upstream` — the user has already said so;
 * 2. else we cannot publish, so the remote we cannot write to IS upstream
 *    (the ordinary clone: one remote, read-only);
 * 3. else we can publish somewhere that is not the canonical repo, which is a
 *    fork — add `upstream` pointing at the canonical repo and use it;
 * 4. else we can publish to the canonical repo, which makes this the author's
 *    checkout: there is nothing above it.
 */
export async function resolveUpstreamRemote(
  root: string,
): Promise<UpstreamRemote> {
  const named = await remoteUrl(UPSTREAM_REMOTE, root);
  if (named !== null) {
    return { kind: "upstream", remote: UPSTREAM_REMOTE, url: named };
  }

  const target = await resolvePublishTarget(root);
  if (target.kind === "local") {
    if (target.reason.kind === "no-remote") {
      return { kind: "none", reason: "no-remote" };
    }
    // Every other local reason carries the remote it was measured against.
    // Note this includes `unreachable`: a remote we could not reach today is
    // still the remote this checkout came from, and the upstream reader's own
    // fetch is where that failure belongs — not in a claim that there is no
    // upstream at all.
    return {
      kind: "upstream",
      remote: target.reason.remote,
      url: target.reason.url,
    };
  }

  if (sameRepoUrl(target.url, SOURCE_REPO_URL)) {
    return { kind: "none", reason: "is-publisher" };
  }
  return await addCanonicalUpstream(root);
}

/**
 * A fork we can write to needs somewhere to receive from, and its `origin` is
 * the fork rather than the source. Adding the remote is the whole fix, and it
 * is idempotent: a concurrent process that won the race left exactly the
 * remote we were about to create, so we read it back rather than fail.
 */
async function addCanonicalUpstream(root: string): Promise<UpstreamRemote> {
  const result = await spawnCaptured(
    ["git", "remote", "add", UPSTREAM_REMOTE, SOURCE_REPO_URL],
    { cwd: root, timeoutMs: REMOTE_ADD_TIMEOUT_MS },
  );
  if (result.exitCode === 0) {
    return {
      kind: "upstream",
      remote: UPSTREAM_REMOTE,
      url: SOURCE_REPO_URL,
    };
  }
  const existing = await remoteUrl(UPSTREAM_REMOTE, root);
  if (existing !== null) {
    return { kind: "upstream", remote: UPSTREAM_REMOTE, url: existing };
  }
  throw new Error(
    `Could not add the '${UPSTREAM_REMOTE}' remote for ${SOURCE_REPO_URL} ` +
      `(git exited ${result.exitCode}); this checkout can publish to ` +
      `${PUBLISH_REMOTE} but has no upstream to receive from.` +
      (result.stderr.trim() ? `\n${result.stderr.trim()}` : ""),
  );
}
