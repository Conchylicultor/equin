# Live reconnects: linger a closed socket's subs; one runtime-wide version clock

Task: task "A live-resource reconnect reloads every subscription, and the runtime's per-subscription
version map grows without bound" (replaces task-1790678610076-15bp4c). Background:
`research/2026-09-27-global-live-substrate-gaps.md`, *Review round* #4 and #5.

## Context

Two defects in `resource-runtime/core/runtime.ts`:

1. **Every reconnect reloads everything.** `registerSubOnSocket` opens a new tracking span — a fresh,
   higher version — on a tuple's global 0→1. A socket `close` releases every tuple the socket held, so
   the replay on the next socket finds each one at 0 and opens a span: none can short-circuit, and the
   whole sub set reloads through the 6-slot read gate. This is a network blip, a wake from sleep, a
   SharedWorker restart. (The "leader-tab handover" of the task text no longer exists: the socket lives
   in a SharedWorker, `primitives/networking/web/shared-ws-host.ts`; a tab leaving sends its will
   `unsub-tab`, not a close.)
2. **`entry.versions` only grows.** One entry per distinct tuple ever subscribed, never deleted
   (`:rows` tuples are keyed by whole id sets). It cannot be deleted at N→0 as is: the per-pk counter
   would restart, and a restarted count could equal a version an old tab still holds.

Hard constraint: a tab is never told `up-to-date` over a change made while nothing tracked its tuple —
files, git and `whileSubscribed` watchers included, not only the change feed.

## Measured (before)

- **Main, `_debug`, ~1 h after a restart** (2026-11-04 21:49): 468 entries, **748** version-map
  entries for **444** tracked tuples (304 dead, ~40% after one hour; worst: `background.recent-runs`
  109 entries / 0 tracked, `conversations.by-id:rows` 83 / 72, `config-v2.values` 76 / 61).
  `subShortCircuits` summed over every key: **0**.
- **Reconnect burst** (`network/live/e2e/reconnect-cost.ts`, this worktree's build of main): see
  *Measurements* below.

## Design

### 1. Linger: a closed socket's subs stay tracked until their tab replays (or a bound)

A socket `close` is not a tab leaving (that is `unsub-tab`, sent by the worker as the tab's will). So on
`close` the runtime **detaches** the socket's `SocketState` instead of releasing it: its sub records keep
their refcounts — every tuple stays tracked (change-feed routing, `whileSubscribed` watchers, notify
targets), so any change in the gap still mints a version, and the replay's echoed version matches only
when nothing changed. That is exactly the existing same-socket short-circuit, extended across the gap;
no new proof is needed and it holds for every resource kind.

A detached record is released:

- when its tab restates its whole set on a new socket — the `sub-batch complete: true` replay — right
  AFTER the batch registered (so a restated tuple goes 1→2→1, never through 0, and short-circuits; a
  tuple the tab no longer wants is released as today's reconciliation would);
- when its tab's `unsub-tab` arrives on any socket;
- when the linger bound expires (`SOCKET_LINGER_MS`, 30 s, one one-shot timer per detached socket): a
  tab that never came back (browser quit, worker killed). Its cost is ≤ 30 s of tracking nobody reads.

Release reuses `releaseTabSubs` / `releaseSubRefcount` unchanged. Sending iterates `sockets` only, so a
detached state never receives a frame; every path that enumerates *tracked* tuples must count it:

- `subscribedParamsFor` (the param-less `notify()` fan-out) reads `entry.tracked` instead of walking
  sockets — the same set, and it includes lingering tuples (otherwise a notify in the gap would skip
  them and break the constraint);
- `unregisterTupleEverywhere` (contract eviction) drops the tuple from detached states too.

A wake longer than the bound, or a server restart (the epoch handoff's job), still reloads.

Not chosen: an entry-level change stamp proving an untracked gap clean — only a routed, fully-fed DB
entry has a complete untracked signal (the handoff's `inheritable` set: 12 of 79 subscribed keys on
main), so files/git/watchers/externals and every window would still reload, at far more complexity.

### 2. One runtime-wide version clock; a version lives exactly as long as its span

- `let clock = 0`; every mint is `++clock` (`mintVersion(entry, pk)`): the span opener in
  `registerSubOnSocket` and every flush bump (`drainMembershipFull`, the membership delta, the value
  drain's immediate and deferred mints). A mint for an untracked tuple (a persisted `{}` recomputed with
  nobody subscribed, a drain that outlived its span) is not stored.
- `releaseSubRefcount`'s N→0 deletes `versions[pk]`. Invariant: `versions.has(pk) ⇔ subCounts(pk) > 0`.
- A version is never reused: every later span opens at a clock value above every version ever handed
  out, so deleting is safe.
- Comparisons (the short-circuits, `noteRead`, derive's `source-moved`, `claimInherited`) read
  `versions.get(pk)` — an untracked tuple equals nothing. Reports (sub-ack, HTTP body) read
  `versionOf(entry, pk) = versions.get(pk) ?? clock`: an untracked read reports the clock, never 0, so a
  WebSocket-down HTTP fallback is not dropped as older than the tab's held version.
- Tracking spans are numbered by the same clock: `entry.spans` holds the opener's version (no
  separate span counter).
- Epoch handoff: `claimInherited` adopts a foreign version and raises `clock` to at least it, so later
  mints stay above it. Its "fresh here" test (`current !== 1`, the opener was the only mint) becomes
  `current !== entry.spans.get(pk)`.

### Found in review (fixed)

- **A keyed tuple held only by lingering sockets kept a stale diff base.** `drainMembershipFull` mints
  but computes no value without a live subscriber, so the snapshot fell behind; the replay's
  `serveSub` seeds only when none exists, so a later delete outside the stale snapshot was a no-op the
  tab never saw. The drain now evicts the snapshot when the tuple is tracked with nobody to send to
  (not a kept idle snapshot); the replay — which the minted version makes reload — reseeds it.
- **A replay that raced the old socket's close** left the tab's records lingering the full bound. At
  close, a tab already holding subs on a live socket has its records there released at once (early
  release can only cost a reload).

## Files

- `plugins/network/plugins/live/plugins/resource-runtime/core/runtime.ts` — both changes.
- `…/resource-runtime/core/*.test.ts` — new tests (below).
- `…/resource-runtime/CLAUDE.md` — spans, linger, clock; `live-state/CLAUDE.md` if it describes reconnect
  reloads.
- `plugins/network/plugins/live/e2e/reconnect-cost.ts` — the measurement (new).
- `research/2026-09-27-global-live-substrate-gaps.md` — mark #4/#5 done.

## Verification

- Unit (runtime, fake sockets): a close then a complete replay of the same tab answers
  `up-to-date-batch` with zero loads; a change (feed route, `notify()`, `notify(params)`) during the gap
  makes the replay reload; a tab that never returns is released at the bound (`onLastUnsubscribe` runs,
  the version entry is gone); `unsub-tab` releases a detached tab at once; a tab replaying without a tuple
  releases it; `versions.size === tracked.size` after churn; an untracked HTTP read reports ≥ every
  version handed out; a re-subscribed tuple never re-uses an old version.
- Existing suites (`./equin test plugins/network/plugins/live`).
- e2e: `reconnect-after-gap.ts` (a change in a held gap still reloads), `reconnect-cost.ts` before/after.
- `_debug` on the built worktree: version entries == tracked tuples.

## Measurements

`./equin run plugins/network/plugins/live/e2e/reconnect-cost.ts` on this worktree's build (default
route, one tab), dropping the worktree socket 3× (the server sees a real close):

| | replayed | reloaded (`sub-ack`) | up-to-date | version short-circuits | version map / tracked |
|---|---|---|---|---|---|
| before (main's runtime) | 78 | **40** | 38 (ETag path) | +0 | 158 / 78 |
| after | 76 | **0** | 76 | +76 | 76 / 76 |
| after, reconnect held 5 s | 75 | 0 | 75 | +75 | 75 / 75 |

Before, every non-`revalidate` tuple reloaded through the 6-slot read gate on every reconnect
(replay settled in ~1.4 s); after, one `up-to-date-batch`. The version map now equals the tracked
tuples (main: 748 entries for 444 tracked after ~1 h, before).

Correctness: `reconnect-after-gap.ts` (a notification created while the reconnect is held) — every
`notifications` tuple answered `sub-ack` carrying the new row, never `up-to-date-batch`. The script
was stale against the app (the bell is now a hover-revealed floating action; the create endpoint
takes a minted id and a `category`): it now asserts on the frames alone.

## Trade-offs (for review)

- A tab that never returns (browser quit while the socket was down) keeps its tuples tracked for
  30 s: changes are routed and values recomputed for nobody. Bounded by the linger.
- A reconnect that comes more than 30 s after the server saw the close still reloads everything, as
  before. Whether a sleep counts toward the bound depends on whether the server's timers advance while
  the machine sleeps; not measured here (the reconnect after a wake usually comes within the client's
  first backoff steps, and the server usually sees the close on wake, too).
- Unit tests that wanted "close ⇒ released" now advance the fake clock by `SOCKET_LINGER_MS`.
- One test pinned "next version = base + 1"; with one clock it is "> base" (the skip still mints
  nothing — its only frame is an ack).

## Follow-up: does the linger survive a real sleep? (2026-11-05)

Question: does `SOCKET_LINGER_MS` expire during a Mac sleep, so that every real wake still reloads
everything? It depends on (a) when the server sees the close relative to the sleep, and (b) whether
its timers advance while asleep.

**History, before the linger shipped** (main's client `ws-close` diag in
`~/.equin/worktrees/singularity/logs/live-state.jsonl*` against `pmset -g log`, 2026-10-31 → 11-04;
four full sleeps with a tab open):

| sleep | asleep | `/ws/notifications` closes |
|---|---|---|
| 11-03 17:45 → 18:09 (clamshell) | 24 min, 25 dark wakes | −29 s before "Entering Sleep", reopened +0.2 s; none at wake |
| 11-03 19:37 → 20:30 (idle) | 53 min, 4 dark wakes | −29 s before, reopened +0.5 s; **+2.5 s after wake**, reopened +0.7 s |
| 11-03 20:30 → 11-04 00:54 (clamshell) | 4.4 h, 127 dark wakes | −29 s before, reopened +0.2 s; none at wake |
| 11-01 → 11-03 03:10 (battery died, hibernate) | 28 h | **+22.5 s after wake**, reopened at once |

- "Entering Sleep" is stamped at the END of a ~30 s sleep preparation (`Delays to Sleep
  notifications: … timed out (30000 ms)`), so the pre-sleep close and its sub-second reconnect both
  happen while the machine is still awake: the replay lands well inside the linger.
- The socket itself (browser → gateway → Unix socket, all local) usually SURVIVES the sleep: two of
  four wakes closed nothing. Then nothing replays — the best case, the linger is not involved.
- Two wakes closed the socket seconds after the wake, each reconnect within < 1 s of the client
  seeing it. What the client log cannot say is when the SERVER saw those closes: at the wake (the
  linger holds — the replay is < 1 s later), or during a dark wake hours earlier (the 30 s timer
  could fire in a later dark wake or on the wake itself, before the replay).

**Instrument** (this change): `_debug.linger` records per closed socket how the linger ended
(`replayed` / `unsub-tab` / `expired`), its span in wall, monotonic (`performance.now`, the clock
Bun judges the timer by) and asleep time (`packages/sleep-clock`), and `lateReplay` — a tab whose
linger expired coming back (its whole set reloads), measured from the close. Reading it after a
night with sleeps answers both unknowns directly: a `lateReplay` with `asleepMs > 0` is a wake that
overran the bound; `held.monoMs ≈ wallMs` on an `expired` episode whose `asleepMs > 0` means Bun's
timers count sleep.

If wakes do overrun: bound the linger by awake time (the sleep clock), or release on the tab's own
return / departure signals — not a larger number.
