// Tunables of the main-thread stall detector. Imports nothing: the SharedWorker
// bundle includes this file, and a worker chunk must be self-contained (the
// page's import map does not reach workers).
export const STALL = {
  // The worker pings every attached tab this often (one timer for all tabs,
  // running only while a visible tab is attached or a stall is in flight).
  PING_MS: 1000,
  // A visible tab whose last pong is older than this has a stall OPEN.
  OPEN_AFTER_MS: 2000,
  // A stall this long (or longer) is filed as a report + slow-op span.
  REPORT_MIN_MS: 5000,
  // A recovered long frame this long (and under REPORT_MIN_MS) is a slow-op only.
  SLOW_OP_MIN_MS: 1000,
  // The tab posts its LoAF entries this long or longer to the worker (crumbs).
  FRAME_POST_MIN_MS: 200,
  // A worker tick this much later than PING_MS means the host or machine slept:
  // every tab looks stale for the same reason, so nothing is filed.
  SLEEP_LATE_MS: 3000,
  // Tabs that stopped answering within this of each other froze together
  // (one renderer process): one incident, the others its cohort.
  COHORT_WINDOW_MS: 1500,
  // After a tab recovers, wait this long for its LoAF entry before filing.
  FRAME_GRACE_MS: 2000,
  // Breadcrumb ring per tab, scripts kept per frame, string cap.
  CRUMBS: 10,
  MAX_SCRIPTS: 5,
  STRING_CAP: 300,
  // Tab ↔ worker protocol version: a loud tripwire, never a negotiation.
  PROTO: 1,
} as const;

/** The SharedWorker's name (identity is script URL + name). */
export const WATCHDOG_WORKER_NAME = "singularity:main-thread-stall";

/** The Web Lock a tab holds for its port's whole life; granted to the worker ⇒ the tab is gone. */
export function portLockName(portId: string): string {
  return `singularity:main-thread-stall-port:${portId}`;
}

/** The Web Lock a watchdog holds for its whole life; free ⇒ its stored stalls are orphans. */
export function workerLockName(workerId: string): string {
  return `singularity:main-thread-stall-worker:${workerId}`;
}
