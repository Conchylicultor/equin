import type { BootWedgeJournal, BootWedgePayload } from "./kinds";

/** `42s` under 90 s, else `7m` (whole minutes), else `3.1h` past 90 minutes. */
export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/**
 * Where a never-ready boot's time went, from its own journal: the step it was
 * in when it stopped, how long its imports took, its longest steps and how
 * long it ran darwinbg — e.g. "in onReadyBlocking:config_v2 at 77s (imports
 * 62s; slowest onReadyBlocking:database 15s, load:wave-18 13s; darwinbg all
 * 78s)". Null without a journal.
 */
export function describeBootPhases(
  j: BootWedgeJournal | undefined,
): string | null {
  if (j === undefined) return null;
  const where =
    j.diedIn !== null
      ? `in ${j.diedIn} at ${humanMs(j.lastEntryAtMs)}`
      : `last heard at ${humanMs(j.lastEntryAtMs)}`;
  const parts: string[] = [
    j.importedAtMs !== null
      ? `imports ${humanMs(j.importedAtMs)}`
      : "still importing plugins",
  ];
  if (j.slowest.length > 0)
    parts.push(
      `slowest ${j.slowest.map((s) => `${s.id} ${humanMs(s.ms)}`).join(", ")}`,
    );
  if (j.darwinbgMs !== null)
    parts.push(
      j.darwinbgMs >= j.lastEntryAtMs
        ? `darwinbg all ${humanMs(j.darwinbgMs)}`
        : `darwinbg the first ${humanMs(j.darwinbgMs)}`,
    );
  return `${where} (${parts.join("; ")})`;
}

/**
 * The report's one-line message (and the task title's substance), told as
 * what is true now: a boot the gateway is still waiting on, one it gave up
 * on, or one a later boot replaced.
 */
export function describeBootWedge(d: BootWedgePayload): string {
  const phases = describeBootPhases(d.journal);
  const tail = phases === null ? "" : ` — ${phases}`;
  switch (d.state) {
    case "booting":
      return `${d.worktree} boot not ready after ${humanMs(d.wedgedMs)}; the gateway is still waiting on it${tail}`;
    case "failed":
      return (
        `${d.worktree} unusable for ${humanMs(d.wedgedMs)}: the gateway gave up on its boot` +
        (d.gatewayError !== undefined ? ` (${d.gatewayError})` : "") +
        ` and retries it only on a deploy or a browser start${tail}`
      );
    case "killed":
      return `${d.worktree} boot killed before ready (started ${humanMs(d.wedgedMs)} ago); the gateway runs nothing for it now (${d.fleetState ?? "?"}) and boots it again on its next request${tail}`;
    case "restart-failed":
      return `${d.worktree} deploy failed: the new backend was killed before ready after ${humanMs(d.wedgedMs)}, the previous one still serves${tail}`;
    case "superseded":
      return `${d.worktree} boot never became ready — un-ready ${humanMs(d.wedgedMs)}, then superseded${tail}`;
    case "open":
      return `${d.worktree} backend wedged — un-ready ${humanMs(d.wedgedMs)} (legacy report: the gateway may already have killed it)`;
  }
}
