const GATEWAY_WORKTREES_URL = "http://localhost:9000/gateway/worktrees";

interface GatewayWorktree {
  name: string;
  state: string;
}

// The gateway's live view of the fleet: worktree name → its lifecycle state
// string. A worktree is PRESENT in this list exactly while its
// `~/.equin/worktrees/<name>/spec.json` is registered — the gateway
// unregisters a worktree the instant its spec dir/file vanishes (teardown). So
// for the wedged-boot question, presence — regardless of the state STRING — is
// the discriminator we want:
//
//   • The gateway's `state` vocabulary is idle | starting | running |
//     restarting | stopping | broken (gateway/worktree.go). "running" there
//     means the backend PROCESS is up and its socket accepts connections — a
//     LOWER bar than our app-level boot `ready` line (the onReady hook). A
//     backend can be gateway-"running" yet app-wedged: process spawned, socket
//     open, but onReady never fired, so no ready line was ever written. Gating
//     on `state === "running"` (as the sentinel's fleet read does, for a
//     different question) would therefore MISS the exact wedged-now boots this
//     watchdog exists to catch.
//   • Absence, conversely, means the worktree was torn down — an open wedge for
//     it is a dead leftover, not a live outage, and must NOT re-alert.
//
// Hence: ANY presence in the list ⇒ treat as live. Bounded 2s fetch mirrors the
// sentinel's `readFleetFromGateway`; ANY failure returns null ("fleet unreadable
// this tick") so the job can skip open-wedge evaluation rather than misjudge it.
export async function readFleet(): Promise<Map<string, string> | null> {
  try {
    const res = await fetch(GATEWAY_WORKTREES_URL, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`gateway responded ${res.status}`);
    const list = (await res.json()) as GatewayWorktree[];
    return new Map(list.map((w): [string, string] => [w.name, w.state]));
    // eslint-disable-next-line promise-safety/no-bare-catch, promise-safety/no-absorbed-failure -- null IS the discriminated "fleet unreadable this tick" state, consumed as such by the monitor job (which skips OPEN-wedge evaluation rather than mis-file a torn-down worktree); mirrors the sentinel's readFleetFromGateway. Any propagation would be wrong — network down / gateway restarting / timeout / malformed body all map to the same "unreadable" verdict.
  } catch {
    return null;
  }
}
