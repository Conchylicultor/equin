import { resolve } from "node:path";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  CACHE_REMOTE_KEY,
  CACHE_URL_KEY,
  NO_PUBLISH,
  cacheDecision,
} from "./cache";
import { classifyRemoteFailure, type RemoteFailure } from "./classify";
import { gitConfigGet, gitConfigSet } from "./git-config";
import { remoteTransport } from "./remote-url";
import type { LocalReason, PublishTarget } from "./types";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/**
 * The remote a publish goes to. Hardcoded, like `push` itself: `git push`
 * with no remote resolves through `branch.<name>.remote`, which defaults to
 * `origin`, and `push` names `origin` outright when it pushes a branch. A
 * checkout whose only remote is named something else was already outside what
 * `push` supports; inventing a guess here would only move the surprise.
 */
export const PUBLISH_REMOTE = "origin";

/**
 * What the write probe found. The failure arms are the shared
 * `RemoteFailure` — the same causes a failed `fetch` has — plus the one arm
 * that only a write probe can produce.
 */
export type ProbeOutcome = { kind: "writable" } | RemoteFailure;

/**
 * The ref the probe pretends to write.
 *
 * NOT `main`. Pushing `main` asks two questions at once — "may I write here?"
 * and "is my main a fast-forward of yours?" — and git answers the second one
 * LOCALLY, from the refs the remote advertised, before permissions ever come
 * up. So an author whose local main is one commit behind would see the probe
 * fail and be filed as read-only, and publishing would switch itself off.
 * A ref nobody has creates no such question.
 */
const PROBE_REF = LEGACY_IDS.writeProbeRef;

/**
 * Wedge-breaker for the probe. This is the one command in the plugin that
 * talks to the network, so unlike the local `git config` reads it genuinely
 * can take seconds — and, on a black-holed connection, forever. Two minutes is
 * far above any real handshake and far below a human's patience.
 */
const PROBE_TIMEOUT_MS = 120_000;

// Memoized per resolved root: one probe per process, and concurrent first
// callers share the flight (the memo stores the PROMISE). A rejection stays
// cached for the same reason as in `spawn`'s git-root memo — it means git
// itself failed for this root, and every caller must keep failing loudly
// rather than half of them racing a retry.
const memo = new Map<string, Promise<PublishTarget>>();

/**
 * May this checkout publish, and to where?
 *
 * The answer comes from the remote, not from a setting: only the remote can
 * say whether we may write to it. It is recorded in `.git/config` once
 * (see `cache.ts`), so the normal push pays nothing and the first push of a
 * fresh clone pays one dry-run round trip.
 */
export function resolvePublishTarget(root: string): Promise<PublishTarget> {
  const base = resolve(root);
  const hit = memo.get(base);
  if (hit) return hit;
  const entry = compute(base, { useCache: true });
  memo.set(base, entry);
  return entry;
}

/**
 * Re-probe after a REAL push was rejected, and record what comes back.
 *
 * A rejection is newer evidence than anything cached — it is the remote
 * answering the exact question the cache holds a stale guess at — so this
 * ignores the recorded answer and replaces it. The push that failed has
 * already printed git's own error; the value returned here is what the NEXT
 * push will see, which is how a checkout that lost its write access heals
 * itself into local mode instead of failing forever.
 */
export function recordPushRejection(root: string): Promise<PublishTarget> {
  const base = resolve(root);
  const entry = compute(base, { useCache: false });
  memo.set(base, entry);
  return entry;
}

async function compute(
  root: string,
  opts: { useCache: boolean },
): Promise<PublishTarget> {
  const url = await remoteUrl(PUBLISH_REMOTE, root);
  if (url === null) {
    // Nothing to key a cached answer on, and nothing to probe. A checkout with
    // no remote is the clearest local-only case there is.
    return { kind: "local", reason: { kind: "no-remote" } };
  }

  // Decided from the URL, before the cache and without a probe: a dry-run push
  // into a directory is answered by a local receive-pack that writes nothing,
  // so it would say yes to a push the real one may refuse (a checked-out
  // branch, a read-only mount) — or, worse, one it would accept, writing this
  // clone's work into someone else's checkout. Not recorded: the URL is the
  // whole answer, and re-reading it is free.
  if (remoteTransport(url) === "filesystem") {
    return {
      kind: "local",
      reason: { kind: "filesystem-remote", remote: PUBLISH_REMOTE, url },
    };
  }

  if (opts.useCache) {
    const decision = cacheDecision(
      {
        remote: await gitConfigGet(CACHE_REMOTE_KEY, root),
        url: await gitConfigGet(CACHE_URL_KEY, root),
      },
      PUBLISH_REMOTE,
      url,
    );
    if (decision.kind === "hit") return decision.target;
  }

  const outcome = await probeWriteAccess(PUBLISH_REMOTE, root);
  return await record(root, PUBLISH_REMOTE, url, outcome);
}

/**
 * Ask the remote for `receive-pack` without writing anything.
 *
 * `--dry-run` does everything except send the update, and "everything" includes
 * opening the session and requesting the receive-pack service — which is where
 * every hosted forge decides whether this identity may write. `--force` is
 * inert under `--dry-run` (there is no update to force) and is here only to
 * drop the client-side fast-forward check, so the probe cannot fail for a
 * reason that has nothing to do with permissions.
 *
 * `GIT_TERMINAL_PROMPT=0` is the difference between a probe and a hang: git
 * would otherwise stop and ask for a username on the user's terminal, with
 * this child's output going to a capture file where nobody would see the
 * question. `GIT_SSH_COMMAND` gets the same treatment, but only when the user
 * has not set one — their own command is theirs, and the deadline covers it.
 */
async function probeWriteAccess(
  remote: string,
  root: string,
): Promise<ProbeOutcome> {
  // `writable` is a publish-only concept, so it is decided HERE rather than
  // inside the shared classifier — which answers "why did a remote git command
  // fail?" and has no business inventing a success arm for one caller.
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  }
  const result = await spawnCaptured(
    ["git", "push", "--dry-run", "--force", remote, `HEAD:${PROBE_REF}`],
    { cwd: root, env, timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (result.exitCode === 0 && !result.timedOut) return { kind: "writable" };
  return classifyRemoteFailure(result);
}

/**
 * Turn the probe's outcome into a target, recording the two outcomes that are
 * answers about this repository and recording neither of the two that are not.
 *
 * The asymmetry is the point. A cached "read-only" survives until the remote's
 * URL changes or a push is rejected; a cached "unreachable" would survive the
 * flight it was measured on, and tell every later push that the user may not
 * publish because their wifi was off once.
 */
async function record(
  root: string,
  remote: string,
  url: string,
  outcome: ProbeOutcome,
): Promise<PublishTarget> {
  if (outcome.kind === "writable") {
    await gitConfigSet(CACHE_REMOTE_KEY, remote, root);
    await gitConfigSet(CACHE_URL_KEY, url, root);
    return { kind: "publish", remote, url };
  }
  if (outcome.kind === "denied") {
    await gitConfigSet(CACHE_REMOTE_KEY, NO_PUBLISH, root);
    await gitConfigSet(CACHE_URL_KEY, url, root);
  }
  const reason: LocalReason =
    outcome.kind === "denied"
      ? { kind: "read-only", remote, url, detail: outcome.detail }
      : outcome.kind === "no-credentials"
        ? { kind: "no-credentials", remote, url, detail: outcome.detail }
        : outcome.kind === "unreachable"
          ? { kind: "unreachable", remote, url, detail: outcome.detail }
          : { kind: "probe-failed", remote, url, detail: outcome.detail };
  return { kind: "local", reason };
}

/**
 * A remote's current fetch URL, or `null` when no remote by that name exists.
 *
 * `null` is a reading, not a swallowed error: `git remote get-url` exits 2 for
 * a remote that is not configured, and only that exit becomes `null`.
 */
export async function remoteUrl(
  remote: string,
  root: string,
): Promise<string | null> {
  const result = await spawnCaptured(["git", "remote", "get-url", remote], {
    cwd: root,
    timeoutMs: 60_000,
  });
  if (result.exitCode === 0) {
    const url = result.stdout.trim();
    return url ? url : null;
  }
  if (result.exitCode === 2) return null;
  throw new Error(
    `git remote get-url ${remote} failed (exit ${result.exitCode})` +
      (result.stderr.trim() ? `\n${result.stderr.trim()}` : ""),
  );
}

/**
 * The one sentence a caller prints for a resolved target, so `push` and the
 * upstream command cannot describe the same state two different ways.
 *
 * Written in the future tense because it is printed BEFORE the work: a push
 * that then fails its checks never advances anything, and a line claiming it
 * did would be worse than no line at all.
 */
export function describePublishTarget(target: PublishTarget): string {
  if (target.kind === "publish") {
    return `Publishing to ${target.remote} (${target.url}).`;
  }
  const reason = target.reason;
  switch (reason.kind) {
    case "no-remote":
      return (
        `Local only (this checkout has no "${PUBLISH_REMOTE}" remote) — ` +
        `main will advance here, and nothing will be pushed.`
      );
    case "filesystem-remote":
      return (
        `Local only (${reason.remote} is a directory on this machine: ${reason.url}) — ` +
        `main will advance here, and nothing will be pushed.`
      );
    case "read-only":
      return (
        `Local only (${reason.remote} refused a write: ${reason.detail}) — ` +
        `main will advance here, and nothing will be pushed.\n` +
        `  This answer is recorded; to ask the remote again: ` +
        `git config --local --unset ${CACHE_REMOTE_KEY}`
      );
    case "no-credentials":
      return (
        `Local only (${reason.remote} did not accept these credentials: ${reason.detail}) — ` +
        `main will advance here, and nothing will be pushed.\n` +
        `  Not recorded — the remote said nothing about this repository. ` +
        `Fix the credentials and the next push asks again.`
      );
    case "unreachable":
      return (
        `Local only (${reason.remote} could not be reached: ${reason.detail}) — ` +
        `main will advance here, and nothing will be pushed.\n` +
        `  Not recorded — an unreachable remote is not a read-only one. ` +
        `The next push asks again.`
      );
    case "probe-failed":
      return (
        `Local only (the write probe against ${reason.remote} failed: ${reason.detail}) — ` +
        `main will advance here, and nothing will be pushed.\n` +
        `  Not recorded — this failure is not a permission answer.`
      );
  }
}
