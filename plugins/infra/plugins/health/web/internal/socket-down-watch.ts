import type { HostReach } from "./client";
import type { VisibleDeadlines } from "./visible-deadline";

export interface SocketDownWatchDeps {
  deadlines: VisibleDeadlines;
  /** How long (visible time) a live-state socket may stay non-open. */
  downMs: number;
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
 * visible time is a wedge — once its host is shown answering HTTP. When the
 * host gives no answer at all (`reachHost`, `internal/client.ts`: the visitor's network, not our
 * live-state path), nothing is established: the window restarts and the
 * socket is judged again once it has run out — so a socket that stays down
 * after the network is back is still reported, one window later.
 */
export function createSocketDownWatch(
  deps: SocketDownWatchDeps,
): SocketDownWatch {
  // Current non-open status per url; absent = open.
  const down = new Map<string, string>();
  // A reach probe in flight for this url: its answer re-judges, nothing re-arms.
  const probing = new Set<string>();

  function arm(url: string): void {
    if (probing.has(url)) return;
    deps.deadlines.arm(url, deps.downMs, () => {
      probing.add(url);
      void deps
        .reach()
        .then((reach) => {
          probing.delete(url);
          const status = down.get(url);
          if (status === undefined) return; // reopened while asking
          if (reach.kind === "no-answer") {
            arm(url);
            return;
          }
          deps.onWedge(url, status);
        })
        .catch((err: unknown) => {
          probing.delete(url);
          throw err;
        });
    });
  }

  return {
    status(url, status) {
      if (status === "open") {
        down.delete(url);
        deps.deadlines.clear(url);
        return;
      }
      down.set(url, status);
      arm(url);
    },
  };
}
