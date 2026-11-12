import type { ChannelStatuses } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { PUSH_STALL_MS } from "@plugins/infra/plugins/health/web";

/** The two sockets the app lives on, in the order a summary names them. */
const CHANNELS = [
  { key: "worktree", name: "server", subject: "the server" },
  { key: "central", name: "central", subject: "central" },
] as const;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "server", "central", or "server and central". */
function joinNames(names: readonly string[]): string {
  return names.join(" and ");
}

/** "45 s", "3 min", "2 h", "2 h 5 min" — rounded down. */
function formatStall(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** "a", "a and b", "a, b and 1 other", "a, b and 3 others". */
function joinKeys(keys: readonly string[]): string {
  const NAMED = 2;
  if (keys.length <= NAMED) return keys.join(" and ");
  const rest = keys.length - NAMED;
  return `${keys.slice(0, NAMED).join(", ")} and ${rest} other${rest > 1 ? "s" : ""}`;
}

/**
 * The connection row's health, from the two notification sockets' states.
 *
 * - any closed → critical, naming which ("Server disconnected").
 * - any open socket whose server reports EVERY push stopped for
 *   `PUSH_STALL_MS` or more → critical: the socket looks fine, but no change
 *   will reach the screen until that server restarts (the 2026-09-11 and
 *   2026-10-26 incidents).
 * - otherwise any still (re)connecting → attention, `transitioning` so the dot
 *   pulses while the socket is on its way back.
 * - otherwise any open socket whose server reports ONE resource's push stuck
 *   for `PUSH_STALL_MS` or more while the rest flow → attention, naming the
 *   resources: only what reads them is frozen (2026-11-05: `host-fs.peek`
 *   hung on the filesystem read as the whole app stuck).
 * - both open and flowing → ok.
 *
 * Closed outranks stuck, and both outrank reconnecting: a socket that gave up
 * or a server that stopped pushing is worse than a socket that is still trying.
 * One stuck resource is the least of them: everything else still updates.
 */
export function connectionHealth(statuses: ChannelStatuses): HealthStatus {
  const closed = CHANNELS.filter((c) => statuses[c.key] === "closed");
  if (closed.length > 0) {
    return {
      state: "critical",
      summary: `${capitalize(joinNames(closed.map((c) => c.name)))} disconnected`,
    };
  }

  const stuck = CHANNELS.filter(
    (c) =>
      statuses[c.key] === "open" &&
      statuses.serverPushStallMs[c.key] >= PUSH_STALL_MS,
  );
  if (stuck.length > 0) {
    const longest = Math.max(
      ...stuck.map((c) => statuses.serverPushStallMs[c.key]),
    );
    const who = joinNames(stuck.map((c) => c.subject));
    const restarts = stuck.length > 1 ? "restart" : "restarts";
    return {
      state: "critical",
      summary: `Connected, but live updates have been stuck for ${formatStall(longest)} — changes are saved but won't appear until ${who} ${restarts}`,
    };
  }

  const pending = CHANNELS.flatMap((c) => {
    const status = statuses[c.key];
    return status === "connecting" || status === "reconnecting"
      ? [{ verb: status, name: c.name }]
      : [];
  });
  if (pending.length > 0) {
    const sameVerb = pending.every((p) => p.verb === pending[0]!.verb);
    const phrase = sameVerb
      ? `${pending[0]!.verb} to ${joinNames(pending.map((p) => p.name))}`
      : pending.map((p) => `${p.verb} to ${p.name}`).join(", ");
    return {
      state: "attention",
      summary: `${capitalize(phrase)}…`,
      transitioning: true,
    };
  }

  const stalled = CHANNELS.flatMap((c) =>
    statuses[c.key] === "open"
      ? statuses.serverStalledResources[c.key].filter(
          (r) => r.ms >= PUSH_STALL_MS,
        )
      : [],
  );
  if (stalled.length > 0) {
    const longest = Math.max(...stalled.map((r) => r.ms));
    const keys = [...new Set(stalled.map((r) => r.key))];
    return {
      state: "attention",
      summary: `Live updates stuck for ${formatStall(longest)} on ${joinKeys(keys)} — everything else is still updating`,
    };
  }

  return { state: "ok", summary: "Server and central connected" };
}
