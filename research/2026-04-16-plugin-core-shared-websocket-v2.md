---
name: SharedWebSocket primitive — drop-in WebSocket replacement
description: v2 of the leader-elected transport. Mirrors the native WebSocket API exactly; all cross-tab coordination hidden internally.
---

# SharedWebSocket v2 — native-API mirror

## Why v2

v1 exposed a custom `onReady` hook to signal leader handoff. That's one API call more than necessary: the native WebSocket already has `onopen`, which fires every time a fresh socket is established. If we mirror the WebSocket API exactly — including `onopen` firing on every (re)open of the underlying real socket — then the consumer's replay logic is identical to what it would be with a plain reconnecting WebSocket. The primitive becomes a literal drop-in replacement.

## API surface — exactly the WebSocket interface

```ts
// plugin-core/shared-websocket.ts

export class SharedWebSocket extends EventTarget {
  constructor(url: string | URL);

  // --- state ---
  readonly url: string;
  readonly readyState: number;       // CONNECTING | OPEN | CLOSING | CLOSED
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  // --- event handlers (both assignment and addEventListener work) ---
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<string>) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;

  // --- methods ---
  send(data: string): void;          // strings only (v1 scope — all our traffic is JSON)
  close(): void;
}
```

That's it. The public surface is identical to the native `WebSocket` (reduced to the string-only subset we actually use). Nothing about leader election, BroadcastChannel, or Web Locks is visible. A consumer written against the native API can be switched to `SharedWebSocket` by changing one import.

### Semantics (the only part consumers need to internalize)

- **`onopen` fires on every (re)open of the underlying real socket**, in every tab. That includes: initial connect, post-disconnect reconnect, and leader handoff (new leader opens a fresh socket). Consumers that use `onopen` to replay state-that-lives-server-side (subscriptions, auth) work correctly in all three cases, just like with a plain reconnecting WebSocket.
- **`send()` while `readyState !== OPEN` is silently dropped** (matches the "fire and forget" variant consumers pair with reconnect handlers — and avoids a native `DOMException` that would just force every consumer to write the same wrapper). Consumer is expected to re-emit on `onopen`.
- **`close()` is a handle-scoped close**: marks this `SharedWebSocket` instance closed (fires `onclose`, stops dispatching events), but does not tear down the underlying real socket, which stays up as long as any tab has a live handle. Simple and safe — no refcounts needed because handles are one-per-tab in practice; other tabs have their own handles with their own lifetimes.
- **No custom events.** The three WebSocket events (`open`, `message`, `close`) are enough.

## Internal design (private, not part of the API)

### Concerns hidden inside the primitive

1. **Leader election** — `navigator.locks.request(lockName, {mode:"exclusive"}, …)`; winner becomes the owner of the real WebSocket for its tab's lifetime.
2. **Channel fanout** — one `BroadcastChannel(channelName)` per origin. Private message kinds:
   ```ts
   type InternalMsg =
     | { kind: "tx"; data: string }          // follower → leader: please send
     | { kind: "rx"; data: string }          // leader → followers: received
     | { kind: "open" }                       // leader → followers: real WS opened
     | { kind: "close"; code: number; reason: string }; // leader → followers: real WS closed
   ```
3. **Reconnect** — leader-only; same `[500, 1000, 2000, 5000]` backoff as today.
4. **Outbound queue** — leader-side only, drains on real WS open. Followers don't queue; they post `tx` on the channel and leader buffers if needed.
5. **Fallback** — if `BroadcastChannel` or `navigator.locks` is unavailable, every tab opens its own real WS. Branch lives in the constructor.

### Lifecycle diagram

```
  tab loads
     │
     ├─ opens BroadcastChannel(name)
     ├─ requests Web Lock(name)
     │
     ├── becomes leader ──▶ open real WS(url)
     │                         │
     │                         ├─ ws.onopen  →  bc.post({kind:"open"})
     │                         │               fire local onopen
     │                         │
     │                         ├─ ws.onmessage → bc.post({kind:"rx", data})
     │                         │                fire local onmessage
     │                         │
     │                         └─ ws.onclose → bc.post({kind:"close",...})
     │                                          fire local onclose
     │                                          schedule reconnect
     │
     └── becomes follower ──▶ listen on BroadcastChannel
                                │
                                ├─ {kind:"open"}    → fire local onopen
                                ├─ {kind:"rx", d}   → fire local onmessage(d)
                                └─ {kind:"close",…} → fire local onclose

  consumer.send(data):
     if leader:    write to real WS (or queue if not yet open)
     if follower:  bc.post({kind:"tx", data})

  leader's bc listener:
     on {kind:"tx", data} → write to real WS (or queue)

  leader tab closes:
     Web Lock releases → another tab wins → new real WS → {kind:"open"}
     every tab fires onopen → consumer replays state
```

### Leader-owned state
The leader holds exactly one extra thing: an outbound queue (string[]) for messages sent before the real WS is `OPEN`. Drains on `ws.onopen`. That's the entire leader-only state.

### Followers never see leadership
There is no public or internal `isLeader` that consumers can read. Followers don't know they're followers. Their `readyState` mirrors whatever was last broadcast (`open` → `OPEN`, `close` → `CLOSED`, etc.).

## `NotificationsClient` after the refactor

```ts
// plugin-core/notifications-client.ts

export class NotificationsClient {
  private ws: SharedWebSocket;
  private subs = new Map<string, { refcount: number; version: number; key: string; params: ResourceParams }>();

  constructor(private queryClient: QueryClient) {
    this.ws = new SharedWebSocket("/ws/notifications");
    this.ws.onopen = this.replaySubs;
    this.ws.onmessage = (ev) => this.handleServerMessage(JSON.parse(ev.data));
  }

  observe(key: string, params: ResourceParams = {}) {
    const id = idOf(key, params);
    const entry = this.subs.get(id);
    if (entry) { entry.refcount++; return; }
    this.subs.set(id, { refcount: 1, version: 0, key, params });
    this.ws.send(JSON.stringify({ op: "sub", key, params }));
  }

  unobserve(key: string, params: ResourceParams = {}) {
    const id = idOf(key, params);
    const entry = this.subs.get(id);
    if (!entry) return;
    if (--entry.refcount > 0) return;
    this.subs.delete(id);
    this.ws.send(JSON.stringify({ op: "unsub", key, params }));
  }

  private replaySubs = () => {
    for (const { key, params } of this.subs.values()) {
      this.ws.send(JSON.stringify({ op: "sub", key, params }));
    }
  };

  private handleServerMessage = (msg: ServerMsg) => { /* unchanged */ };
}
```

Expected ~75 lines vs current ~210. No Web Lock, no BroadcastChannel, no reconnect bookkeeping, no `isLeader`.

This is indistinguishable from a normal single-tab reconnecting-WebSocket consumer — which is exactly the point.

## Files

- **New**: `plugin-core/shared-websocket.ts` — the primitive. ~160 lines including fallback path.
- **Modify**: `plugin-core/notifications-client.ts` — switch to `SharedWebSocket`; net deletion.
- **Modify**: `plugin-core/index.ts` — export `SharedWebSocket`.
- **New**: `web/src/__tests__/shared-websocket.spec.ts` — Playwright test with two browser contexts on the same origin (see Verification).
- **No change**: `plugin-core/use-resource.ts`, `server/src/resources.ts`, `plugins/tasks/**`, `notificationsWsHandler` on the server.

## Verification

1. `./equin build` and open `http://claude-1776294129.localhost:9000`.
2. **Manual multi-tab regression (the original bug)**:
   - Tab A: `http://equin.localhost:9000/` (no `tasks` sub).
   - Tab B: `http://equin.localhost:9000/tasks`.
   - `curl -X POST http://equin.localhost:9000/api/tasks -d '{"parentId":null}' -H 'content-type: application/json'`.
   - Tab B's list updates live, no reload. Must pass.
3. **Manual leader-handoff**:
   - Two tabs on `/tasks`. Close the first-opened tab (the current leader).
   - `curl -X POST …` again. Surviving tab updates live. Must pass.
4. **No-locks fallback**: in DevTools, `delete navigator.locks; location.reload()`. Every tab opens its own WS; behavior still correct. Inspect Network to confirm.
5. **Automated Playwright test** (lands in same PR):
   - Launch Chromium. Two `browser.newContext()` on same origin.
   - Context A navigates to `/`, Context B to `/tasks`.
   - Context B counts initial `input` rows, `evaluate(() => fetch('/api/tasks', …))`, waits 2s, asserts row count incremented without reload.
   - Second scenario: close Context A's page (leader), POST again from Context B, assert still live.
   - This is the exact reproduction from this session — codified as a permanent guardrail.

## What we are explicitly not doing

- Not adding a public `isLeader` / `onReady` / status event — keeps the API mechanically equivalent to a native WebSocket.
- Not supporting binary frames (`Blob`/`ArrayBuffer`) in v1 — all our traffic is JSON strings.
- Not porting `ReconnectingEventSource` — it has different semantics (one-way, HTTP/2-multiplexed) and no known multi-tab bug.
- Not changing the server-side resource protocol or handler.
