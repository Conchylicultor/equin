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
  /**
   * The box is THIS instance: the server's host-only routes (analytics,
   * messages) are answered by this instance's own gateway, from the data the
   * deployments' `visits` and `messages` write here — no SSH.
   */
  box?: "this-instance";
  deployments: readonly DeploymentFixture[];
}

export interface DeploymentFixture {
  /** A composition id the instance knows (`assertKnownComposition`). */
  compositionId: string;
  hostnames: readonly string[];
  /**
   * Deploy secrets the deployment's composition needs, key -> value, written
   * to the secrets store and approved for this deployment. The writer throws
   * when the composition does not need a key.
   */
  secrets?: Readonly<Record<string, string>>;
  /** Site visits, written through the real collect path (analytics). */
  visits?: readonly VisitFixture[];
  /** Messages sent through the site's contact form, already emailed. */
  messages?: readonly SiteMessageFixture[];
  /** Finished runs only — a `running` row would claim a live CLI leg. */
  runs: readonly DeployRunFixture[];
}

/**
 * One visit to a deployment's site. The visitor key is stable: the same key
 * makes the same fake address and browser, so the analytics recognise a
 * returning visitor (a later visit within the retained window).
 */
export interface VisitFixture {
  startedAgoMs: number;
  /** Any stable key; the writer derives a documentation-range IP and a UA. */
  visitor: string;
  /** Overrides the browser derived from `visitor`. */
  userAgent?: string;
  /** ISO 3166 alpha-2 code the visit's country reads as. */
  country?: string;
  /** `document.referrer` of the landing page. */
  referrer?: string;
  utm?: { source?: string; medium?: string; campaign?: string };
  /** Pages in order; each is open for `engagedMs` before the next. */
  pages: readonly { path: string; engagedMs: number }[];
}

export interface SiteMessageFixture {
  agoMs: number;
  /** The visitor's reply-to address. */
  from: string;
  message: string;
  /** The page the form was on. */
  page: string;
}

export type DeployRunFixture = {
  verb: "update" | "ship" | "converge";
  startedAgoMs: number;
  durationMs: number;
  /**
   * A commit of THIS repository (its subject is read from git and stamped on
   * the run, as a real run's is); null for a run that has none.
   */
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
