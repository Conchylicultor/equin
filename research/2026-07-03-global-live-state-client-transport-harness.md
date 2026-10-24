# Live-State Invariant Harness — Client Half (Track 3b): Transport Seams, Fakes, and H1–H7 Hazard Tests

> Status: implemented (2026-07-03) — all seams, fakes, and hazard tests landed
> as designed; the H6c demoted-leader finding was confirmed and fixed via the
> prescribed `onDemoted` callback. Track 3b of
> [global-comms-structural-fixes](./2026-07-02-global-comms-structural-fixes.md);
> companion to the server half in
> [live-state-server-invariant-harness](./2026-07-03-global-live-state-server-invariant-harness.md)
> (Track 3a, landed). Must land before the A1 cascade migration (Track 1 M4).

## Context

The client transport stack — `NotificationsClient` → `SharedWebSocket` →
`CrossTabElection` — constructs `WebSocket`, `BroadcastChannel`, and
`navigator.locks` directly. No injection seams, no fakes anywhere in the repo,
zero tests. The hazards that live client-side (H1 reopen-gap, H2 reconnect
convergence, H4 duplicate subs, H6 cross-tab handover, H7 level-state
convergence, plus the `no-sub` frame-drop gate and delta-no-base/drift resub)
are verified only by the manual checks in
[the v3 mental-model doc §9](./2026-04-15-global-sse-lifecycle-mental-model-v3.md).
Track 3a proved the pattern server-side (`createResourceRuntime`'s all-optional
hooks + `test-support.ts` fakes + hazard-labeled tests); this track mirrors it
on the client.

Three pieces: (1) seam refactor — injected factories defaulting to the globals,
zero behavior change, production call sites unchanged; (2) deterministic fakes
in the networking plugin, exported for reuse; (3) one named vitest test per
hazard.

Established facts that shaped the design (verified by exploration):

- `new SharedWebSocket(` has exactly **one** call site
  (`notifications-client.ts:706`); `new CrossTabElection(` only inside
  `shared-websocket.ts:45`. Trailing optional params are zero-blast-radius.
- The `no-raw-websocket` check allowlists everything under
  `plugins/primitives/plugins/networking/` — a default `new WebSocket(...)`
  factory there passes with no allowlist edit.
- Boundary rules force the fakes to be **exported from the networking web
  barrel** (live-state tests can only import cross-plugin via barrels;
  live-state → networking is an existing edge).
- `clientLog` (traced on every NotificationsClient action) schedules a real
  250ms `fetch` flush and registers a permanent ws-status-bus listener at
  module eval — live-state tests **must** `vi.mock` it to a no-op.
- `ws-status-bus` / `net-diag-bus` are module-level listener Sets with no
  reset; `NotificationsClient.destroy()` today only unsubscribes the status
  bus — the netdiag subscription and channel sockets/timers leak. Tests need a
  complete `destroy()`.
- No repo test uses `vi.useFakeTimers` yet — this track establishes the
  convention. Vitest fake timers also fake `Date`, so
  `CrossTabElection`'s `Date.now()` staleness math needs **no** clock seam.

## Design

### 1. Seam refactor (production files, behavior-preserving)

**New file `plugins/primitives/plugins/networking/web/transport-types.ts`** —
minimal structural interfaces covering only the members actually used, so
fakes don't implement full DOM types and `navigator.locks` /
`new WebSocket(...)` remain assignable defaults:

```ts
export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<string>) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(): void;
}
export type MakeWebSocket = (url: string) => WebSocketLike;

export interface BroadcastChannelLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}
export type MakeBroadcastChannel = (name: string) => BroadcastChannelLike;

export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: "exclusive" | "shared"; steal?: boolean },
    callback: () => Promise<void>,
  ): Promise<void>;
}
```

**`cross-tab-election.ts`** — `CrossTabElectionOptions` gains
`makeBroadcastChannel?: MakeBroadcastChannel` and
`locks?: LockManagerLike | null`. Tri-state semantics is load-bearing:
`undefined` ⇒ default global (`new BroadcastChannel(name)` /
`navigator.locks ?? null`), `null` ⇒ explicitly absent (the existing
solo-leader fallback). Field types widen to the `*Like` interfaces. No timing
or logic changes (`heartbeatMs`/`timeoutMs` are already injectable).

**`shared-websocket.ts`** — constructor gains
`hooks?: SharedWebSocketHooks = { makeWebSocket?, makeBroadcastChannel?,
locks?, heartbeatMs?, timeoutMs? }`; `makeWebSocket` defaults to
`(u) => new WebSocket(u)`; the rest forward to `CrossTabElection`. Also swap
the two global-constant reads `this.ws…readyState === WebSocket.OPEN`
(lines 71 and 183) to `SharedWebSocket.OPEN` (same numeric value) so injected
sockets don't depend on the global.

**`notifications-client.ts`** — constructor gains
`hooks?: { makeSocket?: (url: string) => SharedWebSocket }` (default
`(u) => new SharedWebSocket(u)`), used in `openChannel`. Tests pass **real**
`SharedWebSocket`s built on fake transports — the version guard, keyed-delta
merge, replaySubs stagger, and keep-alive timers are all exercised for real;
only the three OS globals are faked.

Also extend `destroy()` for clean per-test teardown (inert in prod — destroy
is never called there): capture the constructor's `subscribeNetDiag`
unsubscriber into a field and call it; clear every channel's
`pendingTeardown` timers; `channel.ws.close()` each channel.

Not changed (deliberately): no rng/clock seams (fake timers + a `Math.random`
spy cover backoff jitter); no behavior changes to heartbeat/timeout/backoff/
stagger/keep-alive constants; production call sites arg-for-arg identical.

### 2. Deterministic fakes (`networking/web/test-support.ts`, barrel-exported)

Plain `.ts` with **no vitest import** (importable from both plugins' suites;
never self-collected). Mirrors resource-runtime's `test-support.ts` precedent.

- **`FakeWebSocket` + `FakeWsServer`** — `server.connect(url)` (bound as
  `makeWebSocket`) registers a socket at `readyState 0`. Test affordances:
  `open()` (fires `onopen`; never synchronous in the constructor —
  `SharedWebSocket` assigns handlers after construction), `serverSend(frame)`
  (fires `onmessage`, guarded on `readyState === 1` — a frame sent to a
  closed/connecting socket is silently lost, which is exactly the reopen gap),
  `serverClose()` (fires `onclose` → drives reconnect), captured `sent`
  frames with a `sentJson()` parse helper. Server-side: `all()` /
  `openSockets()` introspection, `restart()` (close every open socket), and an
  optional `onFrame(socket, frame)` auto-responder hook for multi-sub tests —
  the server fake stays dumb/scriptable, never a smart mock.
- **`FakeBroadcastChannelBus`** — `bus.channel(name)` (bound as
  `makeBroadcastChannel`). `postMessage` delivers to every **other** channel
  of the same name (never self — mirrors the real API, load-bearing for the
  election's hello/hb frames), asynchronously on the **real microtask queue**
  (`Promise.resolve().then`) — vitest never fakes microtasks, and
  `advanceTimersByTimeAsync` flushes them between faked timers, so delivery
  interleaves correctly. Payloads are `structuredClone`d so "tabs" can't share
  references. `close()` unregisters; `bus.freeze(channel)` keeps it registered
  but silences both directions (models a frozen tab whose lock is still held).
- **`FakeLockManager`** — per-name `{ holder, queue: FIFO }`.
  `request(name, opts, cb)` **grants asynchronously on a microtask** (real
  `navigator.locks` is promise-based; synchronous grant would re-enter the
  `SharedWebSocket` constructor in a way real code never sees). `steal: true`
  rejects the current holder's outer request promise with
  `new DOMException("stolen", "AbortError")` (→ `demoteToFollower`) and
  installs the stealer; queued waiters stay queued. `releaseTab(name)` models
  a cleanly-closed tab: holder released **without** AbortError, next queued
  waiter granted. Internal single-holder invariant throws if two grants would
  coexist.
- **`createTransportHub()`** — composes the three per-"tab":
  `hub.tab()` → `{ hooks: SharedWebSocketHooks }` sharing one server/bus/locks
  (with test-scaled `heartbeatMs`/`timeoutMs`); `hub.makeSocket(tab)` for
  `NotificationsClient` hooks; `hub.kill(tab)` (clean close: channels closed,
  locks released, its sockets `serverClose`d) and `hub.freeze(tab)` (channels
  silenced, lock **kept** — steal-required handover).

### 3. Hazard tests (vitest, jsdom, `web/__tests__/`)

Conventions (all files): hazard-labeled test names mirroring Track 3a
(`"H4: …"`); `vi.useFakeTimers()` per test with `afterEach` restore; advance
only via the async variants; `vi.spyOn(Math, "random").mockReturnValue(0.5)`
where backoff timing is asserted (delay = exactly `base`); same-plugin
imports are relative (`../notifications-client`), fakes come from
`@plugins/primitives/plugins/networking/web`; live-state files start with
`vi.mock("@plugins/primitives/plugins/log-channels/web", () => ({ clientLog: () => {} }))`;
every test constructs fresh clients/sockets and tears them down in
`afterEach` (`client.destroy()` / `sws.close()`) — the module-level buses are
shared across a file and are cleaned only by proper teardown.

**A — `networking/web/__tests__/cross-tab-election.test.ts`** (election on
fake locks + bus, no sockets): first tab elected; second is follower
(queued); `locks: null` ⇒ solo-leader fallback; down/up message routing with
self-skip; `hello` → `onFollowerJoined`; heartbeat keeps `hasLeader()` true
past `timeoutMs`; **H6-lock** clean close (`releaseTab`) → queued follower
granted, single holder throughout; **H6-lock** frozen leader
(`bus.freeze`) → follower times out, `steal-attempt` published, holder's
promise rejects AbortError → demoted, follower elected; direct steal →
demoted leader re-queues via `requestLock(false)`.

**B — `networking/web/__tests__/shared-websocket.test.ts`** (full
SharedWebSocket on a hub): queue-until-open flushes in order on `open()`;
rx dispatch; reconnect after `serverClose()` — status transitions, backoff
500 → new socket, attempt reset on open, second failure schedules 1000
(backoff index advance); `makeWebSocket` throwing `SyntaxError` schedules a
reconnect instead of crashing; follower-joined → leader rebroadcasts `open`
(pins the `SharedWebSocket.OPEN` swap); **H6-socket**: kill leader tab →
follower elected → exactly one live server socket at every observation point.

**C — `live-state/web/__tests__/notifications-subs.test.ts`** (H4 + gates;
one `NotificationsClient` + fresh `QueryClient` per test):
- `H4: observe/unobserve ×10 → exactly one sub frame; one unsub after the
  keep-alive window` — remounts inside `SUB_KEEPALIVE_MS` resurrect the
  refcount-0 sub with zero WS traffic; advancing past the window after the
  final unobserve yields exactly one `{op:"unsub"}`.
- `H4b: keep-alive teardown fires only after the full window` (no unsub at
  `SUB_KEEPALIVE_MS − 1`, sub deleted at `+ ε`).
- `no-sub gate: a frame for a never-observed key is dropped` — no throw, no
  cache write (the broadcast-to-all-tabs safety).
- `delta-no-base → forced resub` — sub entry present, cache empty; delta
  arrives ⇒ cache untouched, etag cleared, fresh `{op:"sub"}` sent.
- `delta-drift → forced resub` — base seeded via sub-ack; delta whose `order`
  names an id resolvable from neither upserts nor base ⇒ cache unchanged,
  etag cleared, resub.
- `version guard drops stale` — `<=` drop, `>` applies.

**D — `live-state/web/__tests__/notifications-reconnect.test.ts`** (H1, H2, H7):
- `H1: frames lost during the reopen gap → resubscribe converges` — ack v1;
  socket drops; v2 lands on the closed socket (lost); backoff reconnect;
  resub acked at v3 ⇒ cache converges to server truth; exactly one resub per
  active sub.
- `H1b: replaySubs stagger under fake timers` — 8 subs ⇒ batch of 6 at t≈0,
  remaining 2 at +150ms (batch 0 also fires via `setTimeout(…, 0)` — needs
  one async flush).
- `H2: server restart resets version counters → all subs converge` —
  acked v5/v7; restart; post-restart sub-acks at version **1** apply because
  `replaySubs` resets each sub to the −1 baseline **at its send time**.
  Pin the per-sub-at-send-time property: while an earlier stagger batch is
  already re-acked, deliver a live update for a **not-yet-resent** sub —
  it must apply against its still-live baseline, not a prematurely-reset −1.
- `H7: level-state convergence after an external kill` — v1 "working";
  intermediate frame lost; the next full frame v3 "gone" converges (level
  state carries full truth; no replay of stale "working"). Then drive
  `probeMissedUpdates` end-to-end: forced resync (`stagger:false`), settle,
  the returned `MissedFrame` reports `prevVersion → ackVersion`.

**E — `live-state/web/__tests__/notifications-cross-tab.test.ts`** (H6 full
stack: two `NotificationsClient`s, own `QueryClient`s, one hub):
- `H6: leader dies → follower steals, resubs, exactly one live socket` —
  A leader (socket S1) observes k, acked; B follower observes k — B's sub
  relays `tx` → A → **S1** (relay routing pinned); `hub.freeze(A)`; advance
  past `timeoutMs` → B steals, A demoted, B opens S2 and `replaySubs` resends
  B's subs on S2; update v2 on S2 → B's cache converges; never two live
  sockets.
- `H6b: cross-tab frame fan-out` — with both tabs subscribed to k through
  the leader's socket, one server frame reaches both clients' caches (leader
  dispatches locally + broadcasts `rx`).

### 4. Expected finding: demoted leader keeps its socket (fix in scope)

`CrossTabElection.demoteToFollower` has **no callback** — `SharedWebSocket`
never learns it was demoted, so a stolen-from leader (a frozen tab that later
wakes) keeps its real WebSocket open: two live sockets, duplicate `rx`
broadcasts (masked by the version guard, but double server load and a
contradiction of the one-socket invariant). The H6 tests will surface this.
Fix structurally, minimally: add `onDemoted()` to `CrossTabElectionCallbacks`
(single construction site — make it required), called from
`demoteToFollower`; `SharedWebSocket` implements it with `teardownWs()` + a
`reconnecting`-status reset (a demoted tab must not reconnect its own socket —
it is a follower now; the new leader owns the socket). Pin with a named test
(`H6c: demoted leader closes its socket`). If implementation reveals this is
riskier than it looks, land the harness with `test.todo` + file a task —
the Track 3a precedent for divergences.

## Critical files

Modify:
- `plugins/primitives/plugins/networking/web/cross-tab-election.ts` — options seam, `*Like` types, `onDemoted`
- `plugins/primitives/plugins/networking/web/shared-websocket.ts` — hooks seam, `SharedWebSocket.OPEN` swaps, demote handler
- `plugins/primitives/plugins/networking/web/index.ts` — export `transport-types` + `test-support`
- `plugins/primitives/plugins/live-state/web/notifications-client.ts` — `makeSocket` hook, complete `destroy()`
- `research/2026-04-15-global-sse-lifecycle-mental-model-v3.md` §9 — point H1/H2/H4/H6/H7 rows at the named tests (mirroring the H5 row)
- `plugins/primitives/plugins/networking/CLAUDE.md`, `plugins/primitives/plugins/live-state/CLAUDE.md` — hooks/fakes + hazard-tests sections

Create:
- `plugins/primitives/plugins/networking/web/transport-types.ts`
- `plugins/primitives/plugins/networking/web/test-support.ts`
- `plugins/primitives/plugins/networking/web/__tests__/{cross-tab-election,shared-websocket}.test.ts`
- `plugins/primitives/plugins/live-state/web/__tests__/{notifications-subs,notifications-reconnect,notifications-cross-tab}.test.ts`

Reuse (read-only precedents):
- `plugins/framework/plugins/resource-runtime/core/test-support.ts` + `runtime-h5.test.ts` — fake/naming conventions, wire shapes
- `vitest.config.ts` include glob + `test/setup.ts` (localStorage shim)

## Implementation order & verification

1. `transport-types.ts` + seam refactor of the three production files
   (including `SharedWebSocket.OPEN` swaps, `destroy()` completion,
   `onDemoted`). Gate: `./equin check` green (type-check, boundaries,
   no-raw-websocket) — production behavior unchanged except the demote fix.
2. `test-support.ts` fakes + barrel export. Gate: `./equin build`
   (regenerates plugin docs for the widened barrel) + `./equin check`.
3. Test files A, B. Gate: `bun run test:dom plugins/primitives/plugins/networking`.
4. Test files C, D, E. Gate: `bun run test:dom plugins/primitives/plugins/live-state`.
5. Docs (v3 §9 rows, both CLAUDE.mds). Final gates:

```bash
bun run test:dom plugins/primitives/plugins/networking plugins/primitives/plugins/live-state
./equin build
./equin check
```

Acceptance: every hazard maps to a named test (`H1`, `H1b`, `H2`, `H4`,
`H4b`, `H6`, `H6b`, `H6c`, `H7`, no-sub gate, delta-no-base, delta-drift);
build + check green; production call sites byte-identical apart from the
seams and the demote fix; the app still deploys and live updates flow
(smoke-check a task edit pushing to the UI after `./equin build`).

## Risks

- **Fake-timer/microtask interleaving** — resolved by real-microtask bus
  delivery + async timer advancement only.
- **Backoff jitter nondeterminism** — `Math.random` spy, no rng seam.
- **Constructor-time eager worktree socket** — tests treat the first
  `FakeWebSocket` as the worktree channel; documented per file.
- **Module-level bus leak across tests** — completed `destroy()` +
  `afterEach` teardown is the guard; this is why the destroy extension is
  in-scope, not optional.
- **`onDemoted` behavior change** — small and pinned by H6c, but if the
  demote→teardown interaction with `startLeading`'s own `teardownWs` shows
  an ordering subtlety, fall back to `test.todo` + task (documented above).
