import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  combineResources,
  foldResource,
  mapResource,
  type PortableGateInput,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import {
  releaseCandidate,
  releaseHistory,
  type PlatformTag,
  type ReleaseCandidate,
  type ReleaseRun,
} from "@plugins/release/core";
import {
  candidatePredatesLatest,
  resolveReleaseState,
  type ReleaseState,
} from "../../core";

/**
 * What one deployment's release info settles on, once both reads agree:
 *
 * - `no-platform` — the server has no verified platform, so there is no
 *   candidate question at all (a candidate is *for* a platform);
 * - `resolved` — the candidate and the newest run, and `state`, their one
 *   derivation.
 */
export type ReleaseSnapshot =
  | { kind: "no-platform" }
  | {
      kind: "resolved";
      state: ReleaseState;
      candidate: ReleaseCandidate;
      /** Newest run of this composition in this namespace, any platform or kind. */
      latestRun: ReleaseRun | null;
    };

/**
 * Everything the pipeline and the row chip know about one deployment's release
 * candidate, as a read: `loading` (a read has not landed, or the candidate
 * provably predates the newest run — see `candidatePredatesLatest`), `error`
 * (either read failed; a corrupt `RELEASE.json` is the candidate's error, not a
 * refusal), or a ready {@link ReleaseSnapshot} — so "no bundle", "not asked
 * yet", "cannot ask" and "asking failed" never render alike.
 */
export type ReleaseInfo = ResourceResult<ReleaseSnapshot>;

/** The release state a resolved info settles on; `null` for every other state. */
export function releaseStateOf(
  info: ReleaseInfo | undefined,
): ReleaseState | null {
  if (info === undefined) return null;
  return foldResource(info, {
    loading: () => null,
    error: () => null,
    ready: (snapshot) => (snapshot.kind === "resolved" ? snapshot.state : null),
  });
}

const NO_PLATFORM: ReleaseSnapshot = { kind: "no-platform" };

/**
 * The ordering gate, as a gate input of its own: `held` while the candidate
 * provably predates the newest run, `settled` otherwise. Combined with the two
 * reads, a held gate makes the whole info `loading` — the candidate it is
 * waiting for is a push away.
 */
const HELD: PortableGateInput = { status: "loading" };
const SETTLED: PortableGateInput = { status: "ready" };

/**
 * The two questions behind every release affordance in this app, asked
 * together, both live:
 *
 * - **the filesystem**: is there a shippable bundle for this (composition,
 *   platform), and if not, why not — the `release.candidate` value, whose
 *   `resolution` is the exact value `ship` itself acts on;
 * - **the DB**: is a build of this composition running or did the last one
 *   fail — the routed `release.history` window, limit 1: the newest run
 *   whatever its state. The candidate cannot answer this: it is a bundle on
 *   disk, so it is blind to a build in flight and to one that just failed.
 *
 * A `null` platform means the server has no verified platform yet: the
 * candidate is not asked (`useLive(…, null)` reads nothing) and the info
 * settles on `no-platform` once the newest run has landed.
 */
export function useReleaseInfo(
  composition: string,
  platform: PlatformTag | null,
): ReleaseInfo {
  const candidate = useLive(
    releaseCandidate,
    platform === null ? null : { composition, platform },
  );
  // The query is the history window's own default order, spelled out because
  // "newest" is what this read means.
  const latest = useLive(releaseHistory, {
    where: { composition },
    orderBy: [["startedAt", "desc"]],
    limit: 1,
  });

  return useMemo((): ReleaseInfo => {
    const latestRun = mapResource(latest, (rows) => rows[0] ?? null);
    if (platform === null) return mapResource(latestRun, () => NO_PLATFORM);
    const reads = combineResources({ candidate, latestRun });
    const ordered = foldResource(reads, {
      loading: () => SETTLED,
      error: () => SETTLED,
      ready: (d) =>
        candidatePredatesLatest(d.candidate, d.latestRun, platform)
          ? HELD
          : SETTLED,
    });
    return mapResource(
      combineResources({ reads, ordered }),
      ({ reads: d }): ReleaseSnapshot => ({
        kind: "resolved",
        state: resolveReleaseState({
          candidate: d.candidate,
          latestRun: d.latestRun,
        }),
        candidate: d.candidate,
        latestRun: d.latestRun,
      }),
    );
  }, [platform, candidate, latest]);
}
