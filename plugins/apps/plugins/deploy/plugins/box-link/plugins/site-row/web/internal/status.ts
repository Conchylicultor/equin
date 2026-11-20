import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { LinkRefusal } from "@plugins/apps/plugins/deploy/plugins/box-link/core";
import type { SiteHealth } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";
import { shortSha } from "@plugins/apps/plugins/deploy/plugins/remote-deploy/core";

/** A site's name on its row: its first public hostname, else its composition. */
export function siteTitle(site: SiteHealth): string {
  return site.hostname ?? site.compositionId;
}

/** "7:01 PM" — a moment of today, on this computer's clock and locale. */
export function clockTime(at: number | string): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** What it runs: "a1b2c3d". */
function releaseName(site: SiteHealth): string {
  return site.release.kind === "known"
    ? shortSha(site.release.sha)
    : "release unknown";
}

/** What it runs and how that compares with main: "a1b2c3d · up to date". */
function releaseWords(site: SiteHealth): string {
  const { release } = site;
  if (release.kind === "unknown") return releaseName(site);
  return release.behindMain > 0
    ? `${releaseName(site)} · ${plural(release.behindMain, "commit")} behind main`
    : `${releaseName(site)} · up to date`;
}

/** Why a refused link cannot dial, in the words the user acts on. */
export const REFUSAL_WORDS: Record<LinkRefusal, string> = {
  auth: "the server refused this computer's SSH key",
  "host-key-mismatch": "the server's host key changed",
  "forwarding-refused": "forwarding is disabled on the server",
  "no-ssh-key": "the server has no SSH key set up",
  unverified: "the server's connection was never verified",
};

/**
 * The site's line in the health report — its state as a `HealthStatus`, from
 * the one `deploy.site-health` entry (the design's table):
 *
 * | Site | Status |
 * |---|---|
 * | live, up to date | `ok` |
 * | live, behind main | `info` (a new version waits — not a problem) |
 * | deploying | `info`, transitioning |
 * | restarting (a Restart site run, even while down) | `info`, transitioning |
 * | reconnecting | `attention`, transitioning |
 * | deploy failed / outdated | `attention` |
 * | down / unreachable / refused | `critical` |
 *
 * A real box seen from a worktree (`main-only`) has no link state here: the
 * line says what the runs and the running commit do ("Linked from main").
 */
export function siteStatus(site: SiteHealth): HealthStatus {
  const { run } = site;
  const linkState =
    site.link.kind === "linked" ? site.link.link.state : undefined;
  const since = site.link.kind === "linked" ? site.link.link.since : null;
  const prefix = site.link.kind === "linked" ? "Live" : "Linked from main";

  // A restart in flight is what the user just asked for, and the reason the
  // box does not answer: it reads as the restart, not as the outage.
  if (run?.status === "running" && run.verb === "restart") {
    return {
      state: "info",
      transitioning: true,
      summary: `Restarting · since ${clockTime(run.startedAt)}`,
    };
  }
  // What the box itself says comes first: a site that is not answering is
  // not "deploying" or "behind", whatever its last run did.
  switch (linkState?.kind) {
    case "connecting":
      return { state: "unknown" };
    case "down":
      return {
        state: "critical",
        summary: `Not answering since ${clockTime(since ?? Date.now())}`,
      };
    case "unreachable":
      return {
        state: "critical",
        summary: `Unreachable since ${clockTime(since ?? Date.now())}`,
      };
    case "refused":
      return {
        state: "critical",
        summary: `Can't connect · ${REFUSAL_WORDS[linkState.reason]}`,
      };
    case "outdated":
      return {
        state: "attention",
        summary: `${releaseWords(site)} · too old for the live link`,
      };
    case "reconnecting":
      return {
        state: "attention",
        transitioning: true,
        summary: `Live · ${releaseName(site)} · reconnecting…`,
      };
    case "live":
    case undefined:
      break;
  }
  if (run?.status === "running") {
    return {
      state: "info",
      transitioning: true,
      summary: `Deploying · since ${clockTime(run.startedAt)}`,
    };
  }
  if (run?.status === "failed") {
    return {
      state: "attention",
      summary: `${prefix} · ${releaseName(site)} · deploy failed`,
    };
  }
  const behind = site.release.kind === "known" && site.release.behindMain > 0;
  return {
    state: behind ? "info" : "ok",
    summary: `${prefix} · ${releaseWords(site)}`,
  };
}

/**
 * How fresh what the row shows is — the link's word on it, which every
 * section that draws the box's numbers reads, so they agree:
 *
 * - `live` — the link is up: what is shown is seconds old;
 * - `stale` — the link was up and is not now (`lastHeardAt`: when the box
 *   was last heard, `null` when never): numbers are dimmed;
 * - `elsewhere` — this instance does not hold the link (a real box seen
 *   from a worktree): freshness is the copy's own, nothing to dim.
 */
export type SiteFreshness =
  | { kind: "live" }
  | { kind: "stale"; lastHeardAt: number | null }
  | { kind: "elsewhere" };

export function siteFreshness(site: SiteHealth): SiteFreshness {
  if (site.link.kind === "main-only") return { kind: "elsewhere" };
  const { link } = site.link;
  return link.state.kind === "live"
    ? { kind: "live" }
    : { kind: "stale", lastHeardAt: link.lastHeardAt };
}

/** A sentence about what is wrong, drawn under the row's summary. */
export interface SiteAlert {
  tone: "warning" | "critical";
  lead: string;
  /** The rest, muted. */
  rest?: string;
}

const RECONNECT_WHY = {
  slept: "this computer slept; retrying",
  restarting: "the site is restarting for a deploy",
  network: "retrying",
} as const;

/** The row's alert, or `null` when nothing needs saying beyond the summary. */
export function siteAlert(site: SiteHealth): SiteAlert | null {
  if (site.link.kind === "linked") {
    const { link } = site.link;
    const { state } = link;
    switch (state.kind) {
      case "reconnecting":
        return {
          tone: "warning",
          lead: `Lost the connection at ${clockTime(link.lastHeardAt ?? link.since)}`,
          rest: RECONNECT_WHY[state.cause],
        };
      case "down":
        return {
          tone: "critical",
          lead: "The server answers SSH, but equin is not running on it",
        };
      case "unreachable":
        return {
          tone: "critical",
          lead: "Can't reach the server over SSH",
          rest: link.lastError ?? undefined,
        };
      case "refused":
        return {
          tone: "critical",
          lead: `Can't connect: ${REFUSAL_WORDS[state.reason]}`,
        };
      case "outdated":
        return {
          tone: "warning",
          lead: "This site's release predates the live link",
          rest: "deploy it again",
        };
      case "connecting":
      case "live":
        break;
    }
  }
  const { run } = site;
  if (run?.status === "failed") {
    return {
      tone: "warning",
      lead: run.message ?? `The last ${run.verb} failed`,
      rest: clockTime(run.finishedAt ?? run.startedAt),
    };
  }
  return null;
}
