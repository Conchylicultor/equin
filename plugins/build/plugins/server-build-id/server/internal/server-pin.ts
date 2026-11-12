import { GIT } from "@plugins/infra/plugins/paths/server";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { spawnCaptured } from "@plugins/infra/plugins/spawn/core";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/network/plugins/live/plugins/live-state/core";

/**
 * `git rev-parse HEAD` in this checkout, synchronously. Synchronous because the
 * first call has to happen at MODULE EVAL, inside the plugin import wave, where
 * there is no await to reach for. `spawnSync` buffers natively — no JS streams,
 * so it is not the shape the spawn primitive exists to guard against — and this
 * is one tiny read of a ref file.
 *
 * `null` when git cannot answer, which is a determinate state, not a hidden
 * failure: a release bundle has no checkout at all, and every caller below turns
 * it into an explicit `unresolved(reason)`.
 */
const REV_PARSE_HEAD = [
  GIT,
  "--no-optional-locks",
  "-C",
  REPO_ROOT,
  "rev-parse",
  "HEAD",
];

function headSync(): string | null {
  const proc = Bun.spawnSync(REV_PARSE_HEAD);
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString().trim() || null;
}

/**
 * The same read, awaited — for the re-sample at `onAllReady`, where an await
 * exists. A `spawnSync` there froze the backend's one thread for the whole
 * spawn (a process start on a loaded host: tens to hundreds of ms) while the
 * gateway may already be swapping tabs onto it.
 */
async function head(): Promise<string | null> {
  const result = await spawnCaptured(REV_PARSE_HEAD, {
    // A bound around git, a process this code does not control.
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}

// Sampled at module eval — DURING the plugin import wave, so it names the tree
// the plugin graph is being imported from. Nothing recorded this before, which
// is why a process that booted across a checkout swap had no way to say so.
const headAtImport = headSync();

let pin: Resolvable<string> =
  headAtImport === null
    ? unresolved("no checkout — this backend runs from a release bundle")
    : resolved(headAtImport);

/**
 * Re-sample at `onAllReady` and seal the answer. If HEAD moved between the
 * import wave and here, the checkout changed underneath a half-imported process:
 * some modules came from the old tree and some from the new, and NO single
 * commit is honest about what this process is running.
 *
 * So the pin becomes `unresolved` rather than picking either sha. `wantsBuild`
 * treats an unresolved pin as not converged, which forces a rebuild and restart
 * — the correct answer for a server that is genuinely a mix of two trees.
 *
 * Idempotent by construction: once the pin is unresolved it stays that way, so a
 * second call can never talk it back into a commit.
 */
export async function sealServerPin(): Promise<void> {
  if (!pin.resolved) return;
  const headNow = await head();
  if (headNow === null) {
    pin = unresolved("mixed boot — the checkout became unreadable during boot");
    return;
  }
  if (headNow !== pin.value) {
    pin = unresolved(
      "mixed boot — the checkout moved during the plugin import wave",
    );
  }
}

/**
 * This process adopted the deploy of `commit` instead of being restarted for
 * it (`build/restart-skip`): it was judged to run exactly the code a process
 * spawned from that tree would, so it is pinned as one — what a restart's
 * import-time sample would have read. Overrides a mixed-boot pin too: the
 * judgement proved nothing it loaded changed since it started, so it is not
 * a mix.
 */
export function adoptServerPin(commit: string): void {
  pin = resolved(commit);
}

/** The commit this backend process was materialized from, or why it cannot say. */
export function serverPin(): Resolvable<string> {
  return pin;
}

/**
 * The pin as an occurrence stamps it (`reports`' `commit`): the commit, or
 * null when this process cannot name one (no checkout, a mixed boot).
 */
export function serverPinCommit(): string | null {
  return pin.resolved ? pin.value : null;
}
