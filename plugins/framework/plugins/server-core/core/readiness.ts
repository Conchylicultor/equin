import { recordReadyInstant } from "./profiler";

// Server readiness flag. Flipped once the `onReadyBlocking` barrier completes
// (migrations applied, DB pool warm, config registry built). `GET
// /api/health/ready` reports this, and the gateway gates its hot-swap on it so
// it never swaps to a backend that is accepting connections but not yet able to
// serve correctly. Background `onReady` work does NOT gate this flag. Marking
// it also stamps the profiler's ready instant (`timeToReadyMs`), the boot
// monitor's trip metric.
let ready = false;

export function markServerReady(): void {
  ready = true;
  recordReadyInstant();
}

export function isServerReady(): boolean {
  return ready;
}
