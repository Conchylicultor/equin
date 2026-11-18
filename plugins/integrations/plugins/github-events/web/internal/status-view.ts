import type {
  ResourceResult,
  ResourceUnavailable,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ForwarderStatus, GitHubEventsStatus } from "../../core";

/** One read as `useLive` hands it back — a value read may be `unavailable`. */
export type Read<T> = ResourceResult<T> | ResourceUnavailable;

function repoWord(n: number): string {
  return `${n} ${n === 1 ? "repo" : "repos"}`;
}

/** "equinai/equin: <why>" for the forwarders in `state`. */
function named(fs: readonly ForwarderStatus[]): string {
  return fs
    .map((f) => (f.detail === null ? f.repo : `${f.repo}: ${f.detail}`))
    .join(" · ");
}

/**
 * The GitHub events row. Absent wherever no forwarder is meant to run (not
 * the publisher, or no computer); `attention` while it cannot be set up or a
 * forwarder gave up; pulsing while one (re)connects; `ok` once GitHub pinged
 * every one.
 */
export function githubEventsHealth(
  read: Read<GitHubEventsStatus>,
): HealthStatus {
  if (read.status === "unavailable") return { state: "absent" };
  if (read.status === "loading") return { state: "unknown" };
  if (read.status === "error")
    return { state: "unknown", summary: "Couldn't read the GitHub forwarders" };
  const status = read.data;
  switch (status.kind) {
    case "off":
      return { state: "absent" };
    case "not-set-up":
      return {
        state: "attention",
        title: "GitHub events not set up",
        summary:
          status.fix === null
            ? `Not set up: ${status.reason}`
            : `Not set up: ${status.reason} — run \`${status.fix}\``,
      };
    case "on":
      break;
  }
  const fs = status.forwarders;
  const failed = fs.filter((f) => f.state === "failed");
  if (failed.length > 0)
    return {
      state: "attention",
      title: "GitHub events stopped",
      summary: `Forwarder gave up — ${named(failed)}`,
    };
  const reconnecting = fs.filter((f) => f.state === "reconnecting");
  if (reconnecting.length > 0)
    return {
      state: "attention",
      summary: `Reconnecting — ${named(reconnecting)}`,
      transitioning: true,
    };
  const connecting = fs.filter((f) => f.state === "connecting");
  if (connecting.length > 0)
    return {
      state: "ok",
      summary: `Connecting ${repoWord(connecting.length)}…`,
      transitioning: true,
    };
  return { state: "ok", summary: `Connected · ${repoWord(fs.length)}` };
}
