import type { PlatformTag } from "@plugins/release/core";

/**
 * Some Deploy state, in the app's own terms: servers, the compositions each one
 * serves, and the history of runs that put them there. A pure description —
 * times are offsets before the moment it is written, so a fixture reads the same
 * whenever it lands. A server's id is the fixture's (a `srv` id), so the key
 * the writer stores for it is the same secret on every write; every other id
 * is minted by the writer, as the create handlers mint them.
 */
export interface DeployFixture {
  servers: readonly DeployServerFixture[];
}

export interface DeployServerFixture {
  /** A `srv-…` id, stable across writes. */
  id: string;
  name: string;
  host: string;
  port?: number;
  sshUser?: string;
  /**
   * The last reachability check: reached, on this platform, `checkedAgoMs`
   * before now, with the server's key. Omitted: never checked. The key itself
   * is not in a fixture: the writer generates one as Generate key does.
   */
  health?: { platform: PlatformTag; checkedAgoMs: number };
  deployments: readonly DeploymentFixture[];
}

export interface DeploymentFixture {
  /** A composition id the instance knows (`assertKnownComposition`). */
  compositionId: string;
  hostnames: readonly string[];
  /** Finished runs only — a `running` row would claim a live CLI leg. */
  runs: readonly DeployRunFixture[];
}

export type DeployRunFixture = {
  verb: "update" | "ship" | "converge";
  startedAgoMs: number;
  durationMs: number;
  commitSha: string | null;
} & (
  | { status: "succeeded" }
  | {
      status: "failed";
      phaseFailed: "converge" | "build" | "ship" | null;
      exitCode: number;
      message: string;
    }
);
