import { GIT, REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import {
  resolved,
  unresolved,
  type Resolvable,
} from "@plugins/primitives/plugins/live-state/core";

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
function headSync(): string | null {
  const proc = Bun.spawnSync([
    GIT,
    "--no-optional-locks",
    "-C",
    REPO_ROOT,
    "rev-parse",
    "HEAD",
  ]);
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString().trim() || null;
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
export function sealServerPin(): void {
  if (!pin.resolved) return;
  const headNow = headSync();
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

/** The commit this backend process was materialized from, or why it cannot say. */
export function serverPin(): Resolvable<string> {
  return pin;
}
