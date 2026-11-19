import type { HostReach } from "./client";
import type { VisibleDeadlines } from "./visible-deadline";

export interface SocketDownWatchDeps {
  deadlines: VisibleDeadlines;
  /** How long (visible time) a live-state socket may stay non-open. */
  downMs: number;
  /**
   * How long a socket may take to open again once its link works
   * (networking's `SOCKET_RECOVERY_MS`): the window it is given after its host
   * was shown answering, before it is judged.
   */
  recoveryMs: number;
  reach: () => Promise<HostReach>;
  /** The socket stayed down while its host answered HTTP: a wedge. */
  onWedge: (url: string, status: string) => void;
}

export interface SocketDownWatch {
  /** A live-state socket's status change (`open`, `connecting`, `reconnecting`, `closed`). */
  status(url: string, status: string): void;
}

/**
 * The socket-down signal: a live-state socket non-open for `downMs` of
 * visible time is a wedge — once it stays down for a whole `recoveryMs` AFTER
 * its host was shown answering HTTP, and the host still answers then.
 *
 * Why the second window: an answer proves the link works when it ARRIVES, not
 * before. A visitor whose link drops has a health request that hangs rather
 * than fails, and is answered the instant the link returns — a moment before
 * the socket, whose handshake was dialed into the dead link, reopens
 * (equin.ai, 2026-11-19 05:13:38 UTC: the host answered at .281, the socket
 * reopened at .450, and a socket-down wedge was filed for the visitor's
 * 20 s outage). Only a socket that cannot open on a link shown working is
 * ours. When the host gives no answer at all (`reachHost`,
 * `internal/client.ts`), nothing is established: the window restarts.
 */
export function createSocketDownWatch(
  deps: SocketDownWatchDeps,
): SocketDownWatch {
  // Current non-open status per url; absent = open.
  const down = new Map<string, string>();
  // A reach probe in flight for this url, by the episode (open count) it
  // judges: its answer re-judges that episode, nothing re-arms it meanwhile.
  const probing = new Map<string, number>();
  // Urls inside their recovery window: the host answered, the socket is given
  // its chance to open on the link.
  const recovering = new Set<string>();
  const recoveryKey = (url: string) => `${url}\0recovery`;
  // Per url: bumped by every open, so a probe in flight across an open (and a
  // new drop) judges nothing — the new episode has its own window.
  const opens = new Map<string, number>();

  function arm(url: string): void {
    if (recovering.has(url)) return;
    // A probe of an EARLIER episode still in flight does not hold this one.
    if (probing.get(url) === (opens.get(url) ?? 0)) return;
    deps.deadlines.arm(url, deps.downMs, () => judge(url, "down"));
  }

  function judge(url: string, phase: "down" | "recovered"): void {
    const generation = opens.get(url) ?? 0;
    probing.set(url, generation);
    void deps
      .reach()
      .then((reach) => {
        if (probing.get(url) === generation) probing.delete(url);
        // Reopened while asking (and maybe down again since: a new episode).
        if ((opens.get(url) ?? 0) !== generation) return;
        const status = down.get(url);
        if (status === undefined) return;
        if (reach.kind === "no-answer") {
          arm(url);
          return;
        }
        if (phase === "recovered") {
          deps.onWedge(url, status);
          return;
        }
        recovering.add(url);
        deps.deadlines.arm(recoveryKey(url), deps.recoveryMs, () => {
          recovering.delete(url);
          judge(url, "recovered");
        });
      })
      .catch((err: unknown) => {
        if (probing.get(url) === generation) probing.delete(url);
        throw err;
      });
  }

  return {
    status(url, status) {
      if (status === "open") {
        if (down.has(url)) opens.set(url, (opens.get(url) ?? 0) + 1);
        down.delete(url);
        recovering.delete(url);
        deps.deadlines.clear(url);
        deps.deadlines.clear(recoveryKey(url));
        return;
      }
      down.set(url, status);
      arm(url);
    },
  };
}
