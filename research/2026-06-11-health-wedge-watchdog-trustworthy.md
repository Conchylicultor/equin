# Trustworthy live-state wedge watchdog

## Context

The missed-updates wedge watchdog (`plugins/health`) still has two defects after
the sub-bump false-positive fix (`f5db7ee59`):

1. **Window-race false positives.** It compares a sub's `version` captured at
   resync start (`prevVersion`) against a `debugSnapshot()` taken
   `RESYNC_SETTLE_MS = 1500ms` later. Any resource that receives a *genuine live*
   `notify()` during that settle window — delivered normally, not missed —
   advances its version and trips the watchdog. The snapshot cannot distinguish
   "missed while hidden" from "changed live during the window," so a normal tab
   refocus during active app usage can false-fire.

2. **Real and false wedges are indistinguishable in the crash record.** `wedge()`
   reports with a constant `errorType: "LiveStateWedge"` and **no stack**. The
   crash fingerprint is `sha256(errorType + top-3 stack frames)`
   (`plugins/crashes/shared/fingerprint.ts`); with an empty stack and constant
   errorType, *every* wedge — socket-down and missed-updates, every detail
   string — collapses to the single fingerprint `sha256("LiveStateWedge|")`.
   They dedup into one growing-count task, so a genuine silent wedge is invisible
   under socket-down flap noise during triage.

**Goal:** a wedge detector that only fires when the live-state pipeline was
actually stuck, and whose crash records let a real wedge be told apart from a
false alarm.

## Root cause

The detection logic leaks out of the live-state client into the watchdog: the
watchdog calls `resync()` (returns pre-resync versions) + `debugSnapshot()`
(returns *current* versions 1500ms later) and diffs them. The current `version`
field conflates two unrelated causes of advance:

- the **resync sub-ack** delivering a server version higher than what we applied
  while hidden — the genuine missed-frame signal, **and**
- a **live frame** (`update`/`delta`/`invalidate`) applied during the settle
  window — healthy delivery, not a miss.

The server already counts versions correctly (a sub-ack reports the current
version without bumping — `flushNotifies` bumps, `handleSub` does not, per
`f5db7ee59` in `plugins/framework/plugins/resource-runtime/core/runtime.ts`). The
remaining flaw is purely client-side: we measure the wrong thing at the wrong
time.

## Design

### Part 1 — Encapsulate detection as a client primitive (`probeMissedUpdates`)

Move the missed-frame decision into `NotificationsClient`, where the sub state
lives. The watchdog becomes pure policy (toast + crash report + cooldown).

**File: `plugins/primitives/plugins/live-state/web/notifications-client.ts`**

Add two per-sub fields to `ActiveSub` so the two causes of a version advance are
separable:

- `lastAckVersion: number` — the version delivered by the most recent **sub-ack**
  (server truth at the moment of (re)subscribe). Init `-1` in `observe()`; reset
  `-1` in `replaySubs()` (alongside `version`); set in `handleServerMessage` only
  when `msg.kind === "sub-ack"`.
- `liveFrameSeq: number` — a monotonic counter of **live, server-initiated
  frames** (`update` / `delta` / `invalidate`, NOT sub-ack). Init `0` in
  `observe()`; **never reset**; incremented in `handleServerMessage` on those
  kinds. Used as a "did a live frame land during the probe" diff.

In `handleServerMessage`, right after the existing `entry.version = msg.version`
(line ~477), before dispatch:

```ts
if (msg.kind === "sub-ack") {
  entry.lastAckVersion = msg.version;
} else {
  // update | delta | invalidate — a live, server-initiated frame.
  entry.liveFrameSeq++;
}
```

Replace `resync()` / `ResyncSub` (watchdog-only — confirmed sole caller) with:

```ts
export interface MissedFrame {
  key: string;
  params: ResourceParams;
  socket: SocketKind;
  prevVersion: number;
  ackVersion: number;
}

/**
 * Probe for live frames silently missed while the tab was hidden. Forces a
 * resync (also a cheap stale-cache self-heal), waits for sub-acks, and returns
 * only subs whose resync sub-ack revealed a version higher than what we had
 * applied AND that saw no live frame during the probe. The live-frame guard
 * excludes the window race: a genuine notify arriving during settle advances
 * `version`/`liveFrameSeq` but not the missed-frame verdict.
 */
async probeMissedUpdates(settleMs = 1500): Promise<MissedFrame[]> { ... }
```

Algorithm:
1. Snapshot per active sub: `{ id, key, params, socket, prevVersion: sub.version,
   prevLiveSeq: sub.liveFrameSeq }`. Return `[]` if none.
2. `trace("probeMissedUpdates subCount=…")`, then `replaySubs(channel)` on both
   channels (resets `version`/`lastAckVersion` to `-1`, resends subs — the
   forced resync + self-heal).
3. `await` a single one-shot `new Promise(r => setTimeout(r, settleMs))` (inherent
   ack round-trip wait; one-shot, not a poll).
4. Re-look up each snapshot's current sub by id (skip if torn down). It is a
   genuine missed frame iff **all three** hold:
   - `prevVersion >= 0` (had a baseline to miss from), **and**
   - `sub.lastAckVersion > prevVersion` (the resync ack revealed a higher server
     version than we had applied — the gap), **and**
   - `sub.liveFrameSeq === prevLiveSeq` (no live frame applied during the probe →
     the advance was revealed *only* by the ack, not delivered live).
5. Return the matching `MissedFrame[]`.

**Why this is trustworthy (hardened):**
- Comparing against the **sub-ack** version (`lastAckVersion`), not a time-delayed
  `version` snapshot, structurally excludes live frames that arrive *after* the
  ack during the settle window — they bump `version` but not `lastAckVersion`.
  This kills the 1500ms window race.
- The `liveFrameSeq` guard closes the residual ~1-RTT race (a genuine notify
  landing between issuing the re-sub and the server acking it): that notify
  arrives as an `update` frame, bumps `liveFrameSeq`, and suppresses the verdict.
  Healthy delivery during the probe never fires.
- It still catches the **silent-wedge** class (socket reports "open" but frames
  aren't flowing): the resync ack reveals the gap regardless of socket status,
  and no live frame arrives to suppress it. (This is why we do **not** gate on the
  socket-down signal — that would blind us to exactly this class.)

`debugSnapshot()` / `DebugSub` (used by `debug/live-state-health`) are unchanged.

**File: `plugins/primitives/plugins/live-state/web/index.ts`** — drop the
`ResyncSub` export; add `MissedFrame`.

### Part 2 — Simplify the watchdog + per-kind fingerprint

**File: `plugins/health/web/components/wedge-watchdog.tsx`**

Replace the `resync()` + `settleTimer` + `debugSnapshot()` diff block with a call
to the primitive. Guard against overlapping probes with a simple in-flight
boolean (the probe self-resolves after `settleMs`):

```ts
let probing = false;
const onVisibility = () => {
  if (document.visibilityState !== "visible" || probing) return;
  const client = getNotificationsClient();
  if (!client) return;
  probing = true;
  void client.probeMissedUpdates()
    .then((missed) => {
      if (missed.length > 0) {
        const m = missed[0]!;
        wedge("missed-updates", `${m.key} ${m.prevVersion}->${m.ackVersion}` +
          (missed.length > 1 ? ` (+${missed.length - 1} more)` : ""));
      }
    })
    .finally(() => { probing = false; });
};
```

Drop `RESYNC_SETTLE_MS` (now owned by the primitive). The socket-down signal
(Signal 1) is unchanged.

**Per-kind fingerprint** in `wedge()`: the fingerprint reads `errorType` (stack is
empty), so encode the kind there:

```ts
function discriminator(kind: WedgeKind, detail: string): string {
  // socket-down: split by channel (worktree vs central) — distinct failure
  // domains, only two values, no task spam. missed-updates: kind only (a broad
  // pipeline wedge hits every sub — keep it one task; the specific key stays in
  // the message + growing count for triage).
  if (kind === "socket-down") {
    return detail.includes("central") ? "socket-down:central" : "socket-down:worktree";
  }
  return "missed-updates";
}

void report({
  source: "live-state-wedge",
  errorType: `LiveStateWedge:${discriminator(kind, detail)}`,
  message: `live-state wedged: ${kind} — ${detail}`,
  label: "live-state.watchdog",
  url: location.href,
  userAgent: navigator.userAgent,
});
```

Result: three stable fingerprints (`socket-down:worktree`,
`socket-down:central`, `missed-updates`) instead of one. After Part 1 removes the
missed-updates false positives, a `missed-updates` task is trustworthy and no
longer buried under socket-down flap noise. No volatile data (versions, params)
enters `errorType`, so each kind still dedups into one growing-count task.

### Part 3 — Doc touch-ups (prose only)

- `plugins/primitives/plugins/live-state/CLAUDE.md` — the per-hop tracing section
  lists `resync` as an always-on trace line; rename to `probeMissedUpdates`.
- `notifications-client.ts` `ActiveSub.version` JSDoc and
  `resource-runtime/core/runtime.ts` (~line 169, 831) comments reference the
  `resync()` name in prose; update to `probeMissedUpdates`. **The server
  version-counting behavior itself is load-bearing and stays exactly as-is** — a
  sub-ack must keep reporting the current version without bumping.

## Critical files

| File | Change |
|------|--------|
| `plugins/primitives/plugins/live-state/web/notifications-client.ts` | Add `lastAckVersion` + `liveFrameSeq` to `ActiveSub`; set/reset in `handleServerMessage`/`replaySubs`/`observe`; replace `resync()`/`ResyncSub` with `probeMissedUpdates()`/`MissedFrame` |
| `plugins/primitives/plugins/live-state/web/index.ts` | Export `MissedFrame`, drop `ResyncSub` |
| `plugins/health/web/components/wedge-watchdog.tsx` | Call `probeMissedUpdates()`; per-kind `errorType` |
| `plugins/primitives/plugins/live-state/CLAUDE.md` | Trace-line rename (prose) |
| `plugins/framework/plugins/resource-runtime/core/runtime.ts` | Comment rename only (prose) |

## Verification

1. `./equin build` — must pass `type-check` + `eslint` (note: the probe is
   async; `void`/`await`/`.finally` keep `no-floating-promises` happy).
2. **No false positive on healthy refocus during active updates.** Drive with
   Playwright (`e2e/screenshot.mjs` as a base): open a page with a live list
   (e.g. tasks), trigger continuous updates (create/flip tasks via MCP
   `add_task`), then toggle tab visibility (`document.dispatchEvent(new Event('visibilitychange'))`
   after setting `visibilityState` hidden→visible). Confirm **no** "Live updates
   stalled" toast and no new `live-state-wedge` crash row.
3. **Socket-down still fires + distinct fingerprint.** Kill the backend socket
   (or block `/ws/notifications`) for >15s; confirm the socket-down wedge fires.
   Then via MCP `query_db`:
   ```sql
   SELECT fingerprint, error_type, message, count FROM crashes
   WHERE source = 'live-state-wedge';
   ```
   Confirm `socket-down:*` and any `missed-updates` rows carry **distinct**
   fingerprints (not the legacy single `LiveStateWedge|` hash).
4. **Trace sanity.** `tail` `~/.singularity/worktrees/<wt>/logs/live-state.jsonl`
   for `probeMissedUpdates subCount=…` on each refocus and absence of spurious
   wedge reports.
5. Existing pre-fix crash row (old constant fingerprint) is left as-is — harmless
   historical data.
