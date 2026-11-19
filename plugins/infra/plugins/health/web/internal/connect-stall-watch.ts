import type { HostReach } from "./client";

export interface ConnectStallWatchDeps {
  now(): number;
  reach(): Promise<HostReach>;
}

/** A stall established as the live-state path's, with the answers that prove it. */
export interface EstablishedStall {
  /** The host's answer asked about this stall. */
  reach: Extract<HostReach, { kind: "answered" }>;
  /** When the host was first shown answering, before this attempt was dialed. */
  hostAnsweredAt: number;
}

export interface ConnectStallWatch {
  /** The socket at `url` opened: every stall before it is settled. */
  opened(url: string): void;
  /**
   * A handshake to `url`, dialed at `startedAt`, went unanswered for its whole
   * deadline. Resolves to the established stall, or null while nothing shows
   * the link worked when the handshake was dialed.
   */
  stalled(url: string, startedAt: number): Promise<EstablishedStall | null>;
}

/**
 * The connect-stalled signal: a hung handshake is the live-state path's fault
 * only when it was DIALED on a link shown working — after the host answered
 * HTTP — and the host still answers.
 *
 * A health answer proves the link works when it arrives, not before: a
 * visitor whose link drops has its health request hang, answered the instant
 * the link returns — while the handshake that stalled was dialed into the
 * dead link (equin.ai, 2026-11-19 05:21:47–05:22:02 UTC: attempt 3 never
 * reached the box, the page's health requests queued through the outage were
 * all answered at 05:22:01.95, and a wedge was filed). So the first answered
 * stall only records when the host answered; the next attempt, dialed after
 * it, decides: it opens (the link was the visitor's — nothing filed) or it
 * stalls too (filed). A socket that opens clears the record.
 */
export function createConnectStallWatch(
  deps: ConnectStallWatchDeps,
): ConnectStallWatch {
  // Per url: when the host was first shown answering since the socket last
  // opened (and since the last unanswered probe).
  const answeredAt = new Map<string, number>();
  // Per url: bumped by every open, so a probe that was in flight across one
  // (its answer arriving after the socket opened — a request held through the
  // outage) records nothing: that stall is settled.
  const opens = new Map<string, number>();

  return {
    opened(url) {
      answeredAt.delete(url);
      opens.set(url, (opens.get(url) ?? 0) + 1);
    },
    async stalled(url, startedAt) {
      const generation = opens.get(url) ?? 0;
      const reach = await deps.reach();
      if ((opens.get(url) ?? 0) !== generation) return null;
      if (reach.kind === "no-answer") {
        answeredAt.delete(url);
        return null;
      }
      const since = answeredAt.get(url);
      if (since !== undefined && startedAt >= since)
        return { reach, hostAnsweredAt: since };
      if (since === undefined) answeredAt.set(url, deps.now());
      return null;
    },
  };
}
