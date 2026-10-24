# SharedWebSocket decomposition — v2

## Context

v1 proposed extracting `ReconnectingWs` (the easy part) from `SharedWebSocket`. Problem: that leaves ~220 lines of cross-tab coordination still monolithic — which is where the actual bugs live (the frozen-leader incident). The reconnection loop is trivial; the cross-tab logic is where complexity and testability matter.

v2 flips the split: extract the **hard part** (cross-tab leader election with message relay) as a generic, independently testable primitive. Leave the WebSocket + reconnection inline in `SharedWebSocket` since it's simple and tightly coupled to socket state.

## Design: two primitives

### 1. `CrossTabElection<TMsg>` (new: `cross-tab-election.ts`, ~100 lines)

Generic cross-tab leader election with typed bidirectional message relay. Owns all the gnarly stuff: `navigator.locks`, `BroadcastChannel`, heartbeat, timeout, steal.

```ts
interface CrossTabElectionCallbacks<TMsg> {
  /** This tab became the leader. Start owning the resource. */
  onElected(): void;
  /** Leader: a follower sent a message (e.g. outbound data to forward). */
  onFollowerMessage(msg: TMsg): void;
  /** Follower: the leader broadcast a message (e.g. incoming data to dispatch). */
  onLeaderMessage(msg: TMsg): void;
  /** Leader: a new follower joined. Broadcast current state so it syncs up. */
  onFollowerJoined(): void;
}

class CrossTabElection<TMsg> {
  readonly isLeader: boolean;

  constructor(
    name: string,
    callbacks: CrossTabElectionCallbacks<TMsg>,
    opts?: { heartbeatMs?: number; timeoutMs?: number },
  );

  /** Leader → all followers. */
  broadcast(msg: TMsg): void;
  /** Follower → leader. */
  sendToLeader(msg: TMsg): void;

  close(): void;
}
```

**Internal BroadcastChannel protocol** (private — consumers never see this):
```ts
type ChannelFrame<T> =
  | { k: "down"; msg: T }    // leader → followers (application message)
  | { k: "up"; msg: T }      // follower → leader (application message)
  | { k: "hb" }              // leader → followers (heartbeat)
  | { k: "hello" }           // new follower → leader ("I just joined")
```

The election class:
- Requests the lock normally on construction; calls `onElected()` when granted
- If locks/BroadcastChannel unavailable: calls `onElected()` synchronously (fallback)
- Leader: starts heartbeat timer, handles `"up"` and `"hello"` frames
- Follower: resets timeout on any frame from leader; steals lock after timeout
- On steal: calls `onElected()` on the new leader (old leader is dead/frozen)

**What this class does NOT know:** WebSocket, reconnection, status bus, readyState.

**Why this is the right boundary:** The frozen-leader bug lived entirely in this layer. Extracting it means the heartbeat/timeout/steal logic is testable in isolation — mock `BroadcastChannel`, advance timers, verify steal fires.

### 2. `SharedWebSocket` (refactored: `shared-websocket.ts`, ~130 lines)

Thin WebSocket consumer of `CrossTabElection`. Manages the socket + reconnection inline (it's only ~30 lines of backoff logic, not worth a class).

```ts
type WsRelayMsg =
  | { kind: "rx"; data: string }
  | { kind: "tx"; data: string }
  | { kind: "open" }
  | { kind: "close" };

class SharedWebSocket {
  private election: CrossTabElection<WsRelayMsg>;
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private attempt = 0;
  private retryTimer: ... | null = null;

  constructor(url: string | URL) {
    this.election = new CrossTabElection(name, {
      onElected: () => this.connectWs(),
      onFollowerMessage: (msg) => {
        if (msg.kind === "tx") this.writeOrQueue(msg.data);
      },
      onLeaderMessage: (msg) => {
        switch (msg.kind) {
          case "rx": this.dispatchMessage(msg.data); break;
          case "open":
            this.readyState = OPEN;
            this.setStatus("open");
            this.dispatchOpen();
            break;
          case "close":
            this.readyState = CONNECTING;
            this.setStatus("reconnecting");
            break;
        }
      },
      onFollowerJoined: () => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.election.broadcast({ kind: "open" });
        }
      },
    });
  }

  // ... connectWs, scheduleReconnect, writeOrQueue (~30 lines total)
  // ... send, close, dispatchers, setStatus (~40 lines total)
}
```

The reconnection logic (backoff timer, queue, attempt counter) stays inline because:
- It's only ~30 lines
- It's tightly coupled to the WebSocket instance lifecycle
- No other consumer needs "reconnecting WS without cross-tab sharing" as a class (the `useReconnectingWebSocket` hook already serves that role)

## Why v2 is better than v1

| | v1 (extract ReconnectingWs) | v2 (extract CrossTabElection) |
|---|---|---|
| Extracts | The easy part (retry loop) | The hard part (leader election) |
| Remaining monolith | 220 lines of cross-tab code | 130 lines of WS + dispatching |
| Bug-prone code isolated? | No — cross-tab logic still mixed | Yes — election is independently testable |
| Reuse potential | Low — hook already exists | Higher — any future shared resource |
| Total complexity reduction | Marginal | Significant |

## Implementation

### Step 1: Create `cross-tab-election.ts`

```
plugins/primitives/plugins/networking/web/cross-tab-election.ts
```

Internal structure:
```
constructor:
  - resolve locks + BroadcastChannel availability
  - fallback path: set isLeader=true, call onElected() synchronously, return
  - create BroadcastChannel, set onmessage handler
  - post { k: "hello" } to announce
  - request lock (normal, not steal)
  - arm leader timeout

onChannelMessage(frame):
  switch frame.k:
    "down" → if follower: touchLeader(), callbacks.onLeaderMessage(frame.msg)
    "up"   → if leader: callbacks.onFollowerMessage(frame.msg)
    "hb"   → if follower: touchLeader()
    "hello"→ if leader: callbacks.onFollowerJoined()

becomeLeader():
  isLeader = true
  stopTimeout()
  startHeartbeat()
  callbacks.onElected()

requestLock(steal):
  navigator.locks.request(name, { exclusive, steal }, () => {
    becomeLeader()
    return new Promise(() => {})  // hold forever
  })
  if !steal: armTimeout()

startHeartbeat():
  setInterval(() => postChannel({ k: "hb" }), heartbeatMs)

armTimeout / checkAlive / touchLeader:
  (same logic as current SharedWebSocket, ~20 lines)

broadcast(msg):
  postChannel({ k: "down", msg })

sendToLeader(msg):
  postChannel({ k: "up", msg })

close():
  clear timers, close channel
```

### Step 2: Refactor `shared-websocket.ts`

Remove from class:
- All lock-related fields and methods (`locks`, `requestLock`, `armLeaderTimeout`, `stopLeaderTimeout`, `checkLeaderAlive`, `lastLeaderSignal`, `leaderTimeoutTimer`)
- All heartbeat fields and methods (`heartbeatTimer`, `startHeartbeat`)
- All BroadcastChannel fields and methods (`channel`, `name`, `postChannel`, `onChannelMessage`, `touchLeaderSignal`)
- The `InternalMsg` type and `isLeader` field

Add:
- `election: CrossTabElection<WsRelayMsg>`
- Wire callbacks as shown above

Keep inline:
- `ws`, `queue`, `attempt`, `retryTimer` — connection + backoff
- `connectWs()`, `scheduleReconnect()`, `writeOrQueue()` — reconnection
- `dispatchOpen/Message/Error/Close`, `setStatus` — public API

### Step 3: Update barrel

```ts
export { CrossTabElection } from "./cross-tab-election";
export type { CrossTabElectionCallbacks } from "./cross-tab-election";
```

## File structure after refactoring

```
plugins/primitives/plugins/networking/web/
├── index.ts                        # barrel: add CrossTabElection export
├── cross-tab-election.ts           # NEW: ~100 lines, generic leader election
├── shared-websocket.ts             # REFACTORED: ~130 lines, WS consumer
├── ws-status-bus.ts                # unchanged
├── use-reconnecting-ws.ts          # unchanged
├── reconnecting-event-source.ts    # unchanged
└── fetch-with-retry.ts             # unchanged
```

## Verification

| Check | Command |
|---|---|
| Types | `bunx tsc --noEmit --project web/tsconfig.json` |
| Build | `./equin build` |
| Single tab | Playwright: connect, subscribe tasks, create task, assert push arrives |
| Leader close | Playwright: 2 tabs, close leader, follower takes over, push works |
| Frozen leader | Playwright: 2 tabs, kill leader heartbeat, wait 12s, follower steals |

## Files

- `plugins/primitives/plugins/networking/web/cross-tab-election.ts` — NEW
- `plugins/primitives/plugins/networking/web/shared-websocket.ts` — REFACTOR
- `plugins/primitives/plugins/networking/web/index.ts` — ADD EXPORT
