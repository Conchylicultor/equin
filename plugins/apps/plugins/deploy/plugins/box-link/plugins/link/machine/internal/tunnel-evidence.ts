/**
 * What one tunnel's incarnation has shown about its own liveness, so a stream
 * that got no answer through it is classified on evidence, never on order of
 * arrival. A stream failing with no answer is ambiguous: the tunnel dying
 * and equin not listening behind it look the same from the socket. It becomes
 * `down` only once ssh shows it answered AFTER that attempt began (a forward's
 * target refused a connection: the session is up, nothing listens) — whether
 * ssh's line comes before the stream's failure or after it. The tunnel's
 * exit clears everything: its own `unreachable` names the failure.
 */
export interface TunnelEvidence {
  /**
   * A stream got no answer. `"down"` when ssh already answered since the
   * attempt began; otherwise `"pending"` until ssh answers or the tunnel ends.
   */
  unanswered(
    deploymentId: string,
    startedAt: number,
    error: string,
  ): "down" | "pending";
  /** ssh answered (a forward's target refused): the pending streams it settles as `down`. */
  sshAnswered(at: number): { deploymentId: string; error: string }[];
  /** The stream heard the box (a hello, an HTTP answer): nothing pending for it. */
  heard(deploymentId: string): void;
  /** The incarnation ended (or a new one started): its evidence goes with it. */
  reset(): void;
}

export function createTunnelEvidence(): TunnelEvidence {
  let answeredAt: number | null = null;
  const pending = new Map<string, string>();
  return {
    unanswered(deploymentId, startedAt, error) {
      if (answeredAt !== null && answeredAt >= startedAt) {
        pending.delete(deploymentId);
        return "down";
      }
      pending.set(deploymentId, error);
      return "pending";
    },
    sshAnswered(at) {
      answeredAt = at;
      const settled = [...pending].map(([deploymentId, error]) => ({
        deploymentId,
        error,
      }));
      pending.clear();
      return settled;
    },
    heard(deploymentId) {
      pending.delete(deploymentId);
    },
    reset() {
      answeredAt = null;
      pending.clear();
    },
  };
}
