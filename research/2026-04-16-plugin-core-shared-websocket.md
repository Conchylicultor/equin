---
name: SharedWebSocket primitive (leader-elected, per-origin)
description: Extract a clean, self-contained leader abstraction so NotificationsClient (and future cross-tab features) don't reinvent Web Lock + BroadcastChannel plumbing.
---

# SharedWebSocket — a leader-elected transport primitive

## Context

`plugin-core/notifications-client.ts` owns three concerns at once: (1) Web-Lock leader election, (2) cross-tab BroadcastChannel fanout, (3) the resource subscribe/update protocol. The leader-election concern leaked a correctness bug: `observe()` in a follower tab adds the sub to its local map but never forwards it to the leader, so the leader never sends `sub` to the server, and followers on any page that subscribes to a resource the leader isn't already watching get zero live updates. This was only visible when ≥2 tabs of the same origin were open — the user keeps 20+ on `singularity.localhost:9000`, so it manifests there and not on rarely-opened worktree namespaces.

The fix inside the current class is possible but fragile: three intertwined state machines make it easy to reintroduce similar bugs (e.g. unsub-forwarding, leader-handoff replay, queue-before-open). We want a primitive that makes this class of bug impossible by construction, so `NotificationsClient` becomes a thin consumer and future cross-tab features (logs stream, terminal, etc.) reuse the transport for free.

## Goal

Introduce `SharedWebSocket`: a tiny, self-contained transport that behaves like a regular `WebSocket` from the consumer's point of view, but under the hood elects one tab per origin to own the real connection and transparently forwards traffic from other tabs through it.

## Non-goals

- Don't redesign the resource protocol (`sub` / `sub-ack` / `update` / `invalidate`). Keep the server side untouched.
- Don't change `useResource` / `ResourceDescriptor` / `defineResource` ergonomics.
- Don't port `ReconnectingEventSource` to the new primitive — keep it per-tab.

## API surface (5 methods)

```ts
// plugin-core/shared-websocket.ts

export type SharedWsStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface SharedWebSocketOptions {
  url: string;
  /** Namespace for Web Lock + BroadcastChannel. Defaults to a hash of `url`. */
  name?: string;
}

export class SharedWebSocket {
  constructor(opts: SharedWebSocketOptions);

  /** Send a JSON-serializable message to the server. Routes via the leader. */
  send(msg: unknown): void;

  /** Fires for every message received from the server, on every tab. */
  onMessage(cb: (msg: unknown) => void): () => void;

  /**
   * Fires once on startup and again after a leader handoff. Consumers use
   * this to re-emit durable client-side state (subscriptions, auth, etc.).
   * The transport itself is stateless across handoffs.
   */
  onReady(cb: () => void): () => void;

  /** Optional: for a status indicator in the UI. */
  onStatusChange(cb: (s: SharedWsStatus) => void): () => void;

  close(): void;
}
```

That is the entire public surface. `isLeader`, the Web Lock, the BroadcastChannel, the reconnect backoff, and the outbound queue are all private implementation details.

## Why this shape is minimal and sufficient

- `send` and `onMessage` mirror the native `WebSocket` contract; consumer code reads like normal socket code.
- `onReady` is the one concession to the fact that state on the server side is per-connection. When leadership hands off, the new leader's WS is a fresh socket with no subscriptions; the consumer replays. Replaying is the consumer's job because only they know what "state" means.
- `onStatusChange` is separate from `onReady` because the UI wants connection state even without a state replay.
- Leadership is intentionally *not* exposed. No public `isLeader`. Consumers who ask for it inevitably write different code paths for leader vs follower — which is exactly the bug we're eliminating.

## Internal protocol (private)

One BroadcastChannel per `name`. Three message kinds:

```ts
type ChannelMsg =
  | { kind: "tx"; msg: unknown }       // follower → leader: please write this
  | { kind: "rx"; msg: unknown }       // leader → followers: received this
  | { kind: "status"; s: SharedWsStatus }; // leader → followers
```

`onReady` does not need a channel message: every tab listens for the Web Lock being acquired locally (leader) and infers from its own lifecycle (follower fires `onReady` on construction, then again on every `rx` burst *after* a gap that suggests a reconnect — actually simpler: leader broadcasts a `{kind:"ready"}` on (re)open, every tab fires `onReady` on receipt; the leader also fires it locally).

Concrete lifecycle:

1. Every tab opens a `BroadcastChannel(name)` and races for `navigator.locks.request(name, {mode:"exclusive"}, …)`.
2. Winner becomes leader for its lifetime, opens the real `WebSocket(url)`, and:
   - On WS open: broadcasts `{kind:"status", s:"open"}` + `{kind:"ready"}`, fires `onReady` locally.
   - On WS message: fires `onMessage` locally and broadcasts `{kind:"rx", msg}`.
   - On WS close: reconnects with the same backoff as today; broadcasts status transitions.
3. Followers' `send(msg)` posts `{kind:"tx", msg}` on the channel. Leader's `send(msg)` writes directly to the socket (if open) or to an internal outbound queue that drains on open.
4. On leader death (tab closes), the Web Lock releases, another tab wins, becomes leader, opens a fresh WS. When it broadcasts `{kind:"ready"}`, every tab re-fires `onReady`. Consumers replay their state. Messages sent during the handoff window that didn't make it to a socket are lost at the transport layer and re-sent by the consumer's replay.

### No-support fallback

If `BroadcastChannel` or `navigator.locks` is unavailable (e.g. some private-mode browsers), every tab is its own leader: opens its own WS, no channel fanout. Correct, just N×. The branch lives inside the primitive, not in every consumer.

## NotificationsClient after the refactor

```ts
// plugin-core/notifications-client.ts (sketch)

export class NotificationsClient {
  private ws: SharedWebSocket;
  private subs = new Map<string, { refcount: number; version: number; key: string; params: ResourceParams }>();

  constructor(private queryClient: QueryClient) {
    this.ws = new SharedWebSocket({ url: "/ws/notifications" });
    this.ws.onMessage(this.handleServerMessage);
    this.ws.onReady(this.replaySubs);
  }

  observe(key: string, params: ResourceParams = {}): void {
    const id = idOf(key, params);
    const entry = this.subs.get(id);
    if (entry) { entry.refcount++; return; }
    this.subs.set(id, { refcount: 1, version: 0, key, params });
    this.ws.send({ op: "sub", key, params });   // routes correctly regardless of leadership
  }

  unobserve(key: string, params: ResourceParams = {}): void {
    const id = idOf(key, params);
    const entry = this.subs.get(id);
    if (!entry) return;
    if (--entry.refcount > 0) return;
    this.subs.delete(id);
    this.ws.send({ op: "unsub", key, params });
  }

  private replaySubs = () => {
    for (const { key, params } of this.subs.values()) {
      this.ws.send({ op: "sub", key, params });
    }
  };

  private handleServerMessage = (msg: unknown) => { /* unchanged: sub-ack / update / invalidate / ping */ };
}
```

Three things to note:

1. No more `isLeader`, no more `channel`, no more `connect`/`BACKOFF_MS`/`retryTimer`/`attempt`. All gone.
2. `observe`/`unobserve` always send — the primitive handles routing. The original bug is unrepresentable.
3. `replaySubs` replaces the ad-hoc "replay on `ws.onopen`" path; it also correctly covers leader handoff, which the old code didn't.

Server-side `notificationsWsHandler` is untouched — sub tracking is already per-socket, and a new leader just opens a new socket.

## Files

- **New**: `plugin-core/shared-websocket.ts` — the primitive. ~150 lines.
- **Modify**: `plugin-core/notifications-client.ts` — delete Web Lock / BroadcastChannel / reconnect code; use `SharedWebSocket`. Net deletion, expected final size ~80 lines vs current ~210.
- **Modify**: `plugin-core/index.ts` — export `SharedWebSocket` and types.
- **No change**: `plugin-core/use-resource.ts`, `server/src/resources.ts`, `plugins/tasks/**`, any callers of `useResource`.

## Verification

1. `./equin build` — deploy to `http://claude-1776294129.localhost:9000`.
2. Manual multi-tab repro of the original bug (must now pass):
   - Open tab A on `http://singularity.localhost:9000/` (any page that doesn't subscribe `tasks`).
   - Open tab B on `http://singularity.localhost:9000/tasks`.
   - In a third tab or via `curl`, `POST /api/tasks`.
   - Tab B's list updates live, no reload.
3. Leader-handoff manual test:
   - Open tab A on `/tasks`, tab B on `/tasks`.
   - Close tab A (the leader — the one that opened first).
   - `POST /api/tasks`; tab B still updates live (new leader replayed subs).
4. Fallback sanity: in DevTools, stub `navigator.locks = undefined`, reload. Each tab opens its own WS; behavior still correct.
5. Playwright integration test (new — `web/src/__tests__/shared-ws.test.ts` or similar): 2 browser contexts on same origin, assert cross-tab subs forwarding and leader-handoff replay. This is the test that would have caught the original bug, and it's the only automated guardrail for this class of regression.

## Open decisions to confirm with the user

- **Does `onReady` fire on every `rx` burst after reconnect, or only on leader handoff?** Proposed: leader broadcasts an explicit `ready` message on every (re)open of its own WS; every tab fires `onReady`. This uniformly handles initial connect, server restart, and handoff.
- **Should the Playwright test land in this PR or be a follow-up?** Recommend same PR — otherwise the regression test never gets written.
