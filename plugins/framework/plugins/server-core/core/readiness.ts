import { recordReadyInstant } from "./profiler";

// Server readiness flag. Flipped once the `onReadyBlocking` barrier completes
// (migrations applied, DB pool warm, config registry built). `GET
// /api/health/ready` reports this, and the gateway gates its hot-swap on it so
// it never swaps to a backend that is accepting connections but not yet able to
// serve correctly. Background `onReady` work does NOT gate this flag. Marking
// it also stamps the profiler's ready instant (`timeToReadyMs`), the boot
// monitor's trip metric.
let ready = false;

// Boot-settled flag: every boot phase of this process has run — the post-ready
// phases (`onReady`, `onAllReady`) and the settled phase (`onSettled`) after
// them. `GET /api/health` reports it as `boot: "settled"`, and it is what a
// deploy waits for: a backend that passed its ready barrier and then died in a
// post-ready phase (2026-11-08: main exited ~5 s after ready, every boot) never
// reaches it, so "deployed" can mean "booted to the end and still the same
// process" rather than "answered once".
let settled = false;

export function markServerReady(): void {
  ready = true;
  recordReadyInstant();
}

export function isServerReady(): boolean {
  return ready;
}

export function markServerSettled(): void {
  settled = true;
}

/** Where this process's boot stands, as `GET /api/health` reports it. */
export function serverBootState(): "booting" | "ready" | "settled" {
  if (settled) return "settled";
  return ready ? "ready" : "booting";
}
