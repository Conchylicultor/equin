import { PRODUCT_NAME } from "@plugins/framework/plugins/product-name/core";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import {
  nextReleaseTag,
  releaseVersion,
  type PublisherStatus,
  type Releasability,
} from "@plugins/upstream/plugins/release/core";
import type { Read } from "./updates-view";

/** The publisher's releases, as the row draws them. */
export type Publisher = Extract<PublisherStatus, { kind: "publisher" }>;

export const RELEASES_TITLE = `${PRODUCT_NAME} releases`;

/** A commit as the row names it: 7 characters in a line, 9 in a tooltip. */
const shortSha = (sha: string): string => sha.slice(0, 7);
const tipSha = (sha: string): string => sha.slice(0, 9);

/** "Latest 2026.11.17 · 6h ago", or "No release yet". */
export function releasesSubtitle(latest: Publisher["latest"]): string {
  return latest === null
    ? "No release yet"
    : `Latest ${releaseVersion(latest.tag)} · ${formatRelativeTime(new Date(latest.taggedAt))}`;
}

/**
 * The tag the next cut takes: today's, or `.2`, `.3`… after today's newest —
 * `nextReleaseTag` over the newest release, which is the newest of the day
 * whenever the day has one. The cut names it the same way from every tag.
 */
export function nextRelease(latest: Publisher["latest"], now: Date): string {
  return nextReleaseTag(now, latest === null ? [] : [latest.tag]);
}

/**
 * The commit line under the title: the unreleased count, and — while the
 * commit main serves cannot be released — why, in a few words.
 */
export interface CommitLine {
  /** `null`: nothing unreleased ("No unreleased commits"). */
  unreleased: number | null;
  /** Why the release is held back now (" · main is building 8c1e2f0"). */
  note: string | null;
}

/** The Release button: its label, and either the cut it makes or why not. */
export interface ReleaseAction {
  label: string;
  enabled: boolean;
  tooltip: string;
  /** The build to open beside a failed one ("Open build"). */
  failedRunId: string | null;
}

export interface ReleasesBody {
  line: CommitLine;
  /** `null`: nothing to release, no button. */
  action: ReleaseAction | null;
}

function heldBack(r: Exclude<Releasability, { kind: "ready" }>): {
  note: string;
  tooltip: string;
} {
  switch (r.kind) {
    case "building":
      return {
        note:
          r.commit === null
            ? "main is building"
            : `main is building ${shortSha(r.commit)}`,
        tooltip: "Main is building — you can release once its build passes",
      };
    case "failed":
      return {
        note: "main's last build failed",
        tooltip: `Main's build of ${shortSha(r.commit)} failed — only a commit whose build passed can be released`,
      };
    case "no-build":
      return {
        note: `no finished build of ${shortSha(r.commit)}`,
        tooltip: `Main has no finished build of ${shortSha(r.commit)} on record — only a commit whose build passed can be released`,
      };
    case "not-served":
      return {
        note: "main serves no known build",
        tooltip:
          "Main serves no known build — you can release once its build finishes",
      };
    case "released":
      return {
        note: `main still serves ${releaseVersion(r.tag)}`,
        tooltip: `The commit main serves (${tipSha(r.commit)}) is already released as ${releaseVersion(r.tag)} — you can release once main serves a newer build`,
      };
  }
}

/** What the row's body says and offers, from the status at `now`. */
export function releasesBody(status: Publisher, now: Date): ReleasesBody {
  if (status.unreleased === 0)
    return { line: { unreleased: null, note: null }, action: null };
  const next = nextRelease(status.latest, now);
  const label = `Release ${releaseVersion(next)}`;
  const r = status.releasable;
  if (r.kind === "ready")
    return {
      line: { unreleased: status.unreleased, note: null },
      action: {
        label,
        enabled: true,
        tooltip: `Tag ${tipSha(r.commit)} — the commit main serves, built and checked — as ${next} and publish it`,
        failedRunId: null,
      },
    };
  const held = heldBack(r);
  return {
    line: { unreleased: status.unreleased, note: held.note },
    action: {
      label,
      enabled: false,
      tooltip: held.tooltip,
      failedRunId: r.kind === "failed" ? r.runId : null,
    },
  };
}

/**
 * The commit line in its parts — the count (drawn strong), the words after it
 * and the note: "142" + " unreleased commits" + " · main is building 8c1e2f0".
 */
export function commitLineParts(line: CommitLine): {
  count: string | null;
  rest: string;
} {
  if (line.unreleased === null)
    return { count: null, rest: "No unreleased commits" };
  const n = line.unreleased;
  const words = ` unreleased ${n === 1 ? "commit" : "commits"}`;
  return {
    count: n.toLocaleString("en-US"),
    rest: line.note === null ? words : `${words} · ${line.note}`,
  };
}

/**
 * The row's health. Having unreleased commits is not a problem: `ready` is
 * drawn as attention (the release is the next step) but ambient, so the dot
 * stays green — as is a failed build of the served commit, which the build
 * row itself reports. A build in flight pulses; nothing to release, or a
 * release held back for another reason, is plain ok.
 */
export function releasesHealth(read: Read<PublisherStatus>): HealthStatus {
  if (read.status === "unavailable") return { state: "absent" };
  if (read.status === "loading") return { state: "unknown" };
  if (read.status === "error")
    return { state: "unknown", summary: "Couldn't read the releases" };
  const status = read.data;
  if (status.kind === "not-publisher") return { state: "absent" };
  const words = {
    title: RELEASES_TITLE,
    summary: releasesSubtitle(status.latest),
  };
  if (status.unreleased === 0) return { state: "ok", ...words };
  switch (status.releasable.kind) {
    case "ready":
    case "failed":
      return { state: "attention", ...words, ambient: [] };
    case "building":
      return { state: "ok", ...words, transitioning: true };
    case "no-build":
    case "not-served":
    case "released":
      return { state: "ok", ...words };
  }
}
