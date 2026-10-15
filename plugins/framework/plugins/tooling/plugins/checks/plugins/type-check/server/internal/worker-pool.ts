import { HOST_POOLS } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";

// How many repo-program workers may be alive at once, host-wide — the memory
// bound the CPU grant cannot express. A worker asks its holder's grant for
// `TYPE_CHECK_WORKER_UNITS`, but the grant clamps that to the holder's own
// share, so every holder could run one: on 2026-10-14 two to four 7–14 GB
// workers overlapped on a host in memory duress, and each burned 718–2211 CPU-s
// on a 99.9 %-warm program that costs 29–162 CPU-s alone, while the push queue
// behind the lock holder's worker reached 109 min.
//
// LANED: the background lane (agent builds and checks) gets one slot, the
// interactive lane (the push-lock holder, main's build and check) can take
// either — so an agent's worker can never be what a push waits behind, and
// agent workers run one at a time. Simulated against the incident's load, the
// cap plus foreground priority took mean push latency 119 → 9 min and made
// background checks faster too (research/2026-10-15-global-push-typecheck-lane-priority-and-cap.md).
const { size } = HOST_POOLS["type-check-worker"];

export const typeCheckWorkerPool = defineHostPool({
  id: "type-check-worker",
  size,
  laned: true,
  backgroundLimit: size - 1,
});
