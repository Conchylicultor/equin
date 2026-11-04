import type { LockHolder } from "./observation";

// The words every surface uses for a holder — the report's message, its task
// and the health report's Database row — so they cannot describe one session
// two ways.

function formatDurationMs(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 120) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 120) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/** Who the holder is: its origin, or what little Postgres says about an untagged one. */
export function holderName(h: LockHolder): string {
  if (h.origin !== null) return h.origin;
  const app = h.applicationName === "" ? "" : ` ${h.applicationName}`;
  return `untagged session${app} (pid ${h.pid})`;
}

/**
 * "conversations.usage:sync holds 15 sessions (longest wait 4 min), idle in
 * its transaction for 5 min" — what it does to others first, then what it is
 * doing itself.
 */
export function describeLockHolder(h: LockHolder): string {
  const parts: string[] = [];
  if (h.waiting > 0) {
    const sessions = h.waiting === 1 ? "1 session" : `${h.waiting} sessions`;
    parts.push(
      `holds ${sessions} (longest wait ${formatDurationMs(h.longestWaitMs)})`,
    );
  }
  if (h.idleMs !== null) {
    parts.push(
      `${parts.length > 0 ? "" : "has sat "}idle in its transaction for ${formatDurationMs(h.idleMs)}`,
    );
  }
  return `${holderName(h)} ${parts.join(", ")}`;
}
