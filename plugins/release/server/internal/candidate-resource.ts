import { runtimeNamespace } from "@plugins/infra/plugins/runtime-identity/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/server";
import { refHeadServed } from "@plugins/infra/plugins/git/plugins/git-watcher/server";
import { serveValue } from "@plugins/network/plugins/live/server";
import {
  bundleSignature,
  compareToHead,
  readHeadSha,
  resolveBundle,
} from "@plugins/release/plugins/bundles/server";
import { releaseCandidate } from "../../core/candidate";
import type { PlatformTag } from "../../core/platforms";
import { createCandidateObserver } from "./candidate-observer";

/**
 * The server half of `release.candidate`: what `ship` would pick for one
 * `(composition, platform)`, read off the bundle directory and git.
 *
 * **Why external.** Its truth is the filesystem (`resolveBundle`, the exact
 * call `./singularity deploy ship` makes) and git (`compareToHead`), neither of
 * which the change feed can see. It recomputes on exactly the edges that can
 * move the answer:
 *
 * - **HEAD moved** — `recomputeOn: [refHeadServed]` (staleness is relative to
 *   HEAD);
 * - **a candidate release of this pair closed** — `noteCandidateClosed`, from
 *   `closeReleaseRow`, notifies this one tuple. The CLI claims the
 *   `latest-<platform>` pointer before it exits, so by the time the row closes
 *   the new bundle is on disk.
 *
 * A hand-run `./singularity release` writes no row and so notifies nothing; it
 * is seen on the next HEAD advance, release close or remount — the known limit
 * of a registry nothing watches.
 *
 * The memoized observation itself — signature, close epoch and the freshness
 * floor that keeps `observedAt` honest — is `createCandidateObserver`.
 */

const observer = createCandidateObserver({
  headSha: () => readHeadSha(REPO_ROOT),
  bundleSignature: (pair) =>
    bundleSignature({ namespace: runtimeNamespace(), ...pair }),
  resolve: (pair) => resolveBundle({ namespace: runtimeNamespace(), ...pair }),
  compareToHead: (manifest) => compareToHead(manifest, REPO_ROOT),
});

export const releaseCandidateServed = serveValue(releaseCandidate, {
  source: "external",
  changes: "notified",
  recomputeOn: [refHeadServed],
  loader: (pair) => observer.get(pair),
  revalidate: (pair) => observer.signature(pair),
  // Drop the pair's memo once nobody watches it; its close record stays.
  whileSubscribed: (pair) => () => observer.evict(pair),
});

/**
 * A candidate release of `(composition, platform)` just closed: take a fresh
 * observation of that pair and push it to its readers.
 */
export function noteCandidateClosed(
  composition: string,
  platform: PlatformTag,
): void {
  observer.noteClosed({ composition, platform });
  releaseCandidateServed.notify({ composition, platform });
}
