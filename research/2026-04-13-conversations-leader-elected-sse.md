# Leader-elected SSE for `/api/conversations/stream`

## Context

Today every tab opens its own `EventSource` to `/api/conversations/stream`. With many tabs open on `equin.localhost`, this saturates Chrome's per-host HTTP/1.1 connection cap (~6) and causes multi-second stalls on initial `/api/conversations` fetches (observed: >2s blank + >10s before UI). On the server side, broadcast cost is O(tabs × users) per event, which doesn't scale.

There is also a real bug: each page load opens **two** EventSources, because `ConversationList` (sidebar) and `ConversationView` (route pane) each create their own, doubling the cost.

Fix: route all SSE traffic through a per-origin singleton elected via `navigator.locks`, and rebroadcast events to other tabs via `BroadcastChannel`. Result: N tabs of any origin = **1 server SSE connection**, regardless of how many components subscribe.

This is client-side only. No server changes.

## Server-restart handling

`./equin build` kills and respawns the backend; the SSE connection drops mid-flight. Three things must happen on reconnect:

1. **Reconnect with backoff** — same curve as the rest of the app. plugin-core already ships `useReconnectingWebSocket` (`plugin-core/use-reconnecting-ws.ts`) with `BACKOFF_MS = [500, 1000, 2000, 5000]`. We mirror that for SSE so behavior is uniform.
2. **Publish status to the global bus** — so `health/ReconnectWatcher` (`plugins/health/web/components/reconnect-watcher.tsx`) shows the same "Reconnected to server" toast for SSE drops as it already does for WS. This means calling `publishWsStatus({ url, status })` from `@core` on every state transition.
3. **Re-snapshot on reconnect** — when the new SSE opens, the server replays its `tmux` snapshot (`sse.ts:27–31`). The leader applies it locally, but **followers** also need to know that their cached state may be stale. The leader broadcasts a `{ type: "reset" }` envelope on reconnect; followers drop their `tmux` cache and re-request a snapshot. (For `created`/`deleted`/`title` the components also re-fetch `GET /api/conversations` on the bus's `open`-after-`reconnecting` transition; we can piggyback on the existing `subscribeWsStatus` listener.)

## Approach

A new module `plugins/conversations/web/stream/` exposes a single hook:

```ts
useConversationStream((event: ConversationEvent) => void): void
```

Internally, the module owns a process-wide singleton `ConversationStream` that:

1. **Tries to become leader.** Calls `navigator.locks.request("singularity:conversations:stream", { mode: "exclusive" }, async () => { ... await neverResolves; })`. The lock is held until the tab closes; the held callback never resolves, so the lock is never released voluntarily.
2. **As leader:** uses the new `ReconnectingEventSource` primitive (see Files below) to open and maintain the connection through server restarts, publishing status to `publishWsStatus` from `@core`. On each message, deserializes once, calls local subscribers, and posts the raw event to a `BroadcastChannel("singularity:conversations:stream")`. Maintains an in-memory `tmux` snapshot (`Map<id, TmuxLive>`) updated from `tmux` events. Listens on the channel for `{ type: "request-snapshot" }` from new followers and replies with `{ type: "snapshot", entries: [...] }`. On every reconnect (transition from `reconnecting` → `open`), clears the cache, broadcasts `{ type: "reset" }`, then applies the server's fresh snapshot replay as it arrives.
3. **As follower (lock not yet acquired):** subscribes to the `BroadcastChannel`, posts `request-snapshot` once, applies snapshot reply, then forwards every subsequent broadcast to local subscribers. On `{ type: "reset" }` (leader reconnected to a restarted server), drops local cache and re-requests a snapshot.
4. **Failover:** the leader tab closes → the OS releases the lock → the queued `navigator.locks.request` in another tab resolves → that tab promotes itself, opens an EventSource, starts broadcasting. Followers see no gap in events except possibly missed events during the ~ms-scale handover (acceptable; reconciled by next `tmux` poller tick at most 1s later).

The `ConversationEvent` discriminated union (`plugins/conversations/shared/protocol.ts:3`) is what flows over the channel. Two new internal envelope types `request-snapshot` and `snapshot` are defined alongside it for follower↔leader bootstrap; these never traverse the network.

## Files

**New (plugin-core):**

- `plugin-core/reconnecting-event-source.ts` — framework-agnostic `ReconnectingEventSource` class mirroring the lifecycle and backoff curve of `useReconnectingWebSocket` (`plugin-core/use-reconnecting-ws.ts`). API: `new ReconnectingEventSource({ url, onMessage, onStatusChange })` with `.close()`. Internally calls `publishWsStatus` from `ws-status-bus.ts` so existing toast/UX wiring works for SSE drops the same as WS. Reuses `BACKOFF_MS = [500, 1000, 2000, 5000]`. We use a class, not a hook, because the leader lives outside React in a module-level singleton. Export from `plugin-core/index.ts`.

**New (conversations plugin):**

- `plugins/conversations/web/stream/client.ts` — singleton `ConversationStream` class: leader election via `navigator.locks`, owns one `ReconnectingEventSource`, BroadcastChannel wiring, snapshot cache, request/reply, reset-on-reconnect.
- `plugins/conversations/web/stream/use-conversation-stream.ts` — `useConversationStream(handler)` React hook; subscribes to the singleton on mount, unsubscribes on unmount.
- `plugins/conversations/web/stream/index.ts` — barrel re-exporting the hook.
- `plugins/conversations/web/package.json` — minimal workspace package declaration so the import path `@plugins/conversations/web/stream` resolves under the existing tsconfig path-alias convention.

**Modified:**

- `plugins/conversations/shared/protocol.ts` — add internal envelope types `LeaderEnvelope = ConversationEvent | { type: "request-snapshot" } | { type: "snapshot"; tmux: Array<[id, TmuxLive]> } | { type: "reset" }`. Keep `ConversationEvent` unchanged for the wire protocol.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx:50–89` — replace inline `new EventSource(...)` with `useConversationStream((ev) => { ... })`. Body of the handler is unchanged. Also subscribe to `subscribeWsStatus` from `@core` for the conversations stream URL: on `reconnecting` → `open` transition, re-run `refresh()` so the list is reconciled with the restarted server's DB state.
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:23–40` — same `useConversationStream` replacement; same `subscribeWsStatus`-driven re-fetch of `/api/conversations/:id` on reconnect.

**Removed:** the two inline `EventSource` blocks.

## Key design points

- **Lock-name scoping.** `singularity:conversations:stream` is per-origin (browser scopes locks per origin). Different worktree subdomains get separate leaders, which is correct — they hit different backends.
- **`navigator.locks` semantics.** Calling `request()` with a never-resolving callback is the canonical "hold for tab lifetime" pattern; the browser releases the lock automatically on tab close, BFCache eviction, or navigation. No manual cleanup needed.
- **Snapshot correctness for late followers.** A follower that joins after the leader's initial SSE handshake won't have received the server's startup snapshot. The leader caches `tmux` state in memory and replays it on `request-snapshot`. For `created`/`deleted`/`title` events the existing pattern is fine: the component already calls `GET /api/conversations` for full list, then SSE applies deltas.
- **No server changes.** The wire protocol and SSE handler are untouched. The server still sees one EventSource per leader, and it doesn't know or care about the BroadcastChannel layer.
- **Browser support.** `navigator.locks` and `BroadcastChannel` are available in all modern Chromium, Firefox, Safari 15.4+. Acceptable for this app.
- **Fallback.** If `navigator.locks` is undefined (very old browsers), fall through to the legacy "every tab opens its own EventSource" path. One small `if` in the singleton constructor.
- **HMR / dev safety.** Module-level singleton uses `globalThis.__singularityConversationStream__` to survive Vite HMR module reloads without leaking duplicate EventSources.

## Verification

1. `./equin build` → load `http://claude-1776109343.localhost:9000` once. In DevTools → Network, filter by `stream`. Expect **exactly one** `/api/conversations/stream` request (was 2).
2. Open 5 more tabs of the same origin. Reload Network. Expect still **exactly one** `/api/conversations/stream` connection across all tabs (visible in any one tab's Network panel; the other tabs show no SSE request).
3. Create a conversation in one tab via "New conversation". Verify all open tabs' sidebars receive the `created` event and update their list.
4. Close the tab that holds the SSE (identifiable: it's the only one with a `/api/conversations/stream` entry in Network). Within ~100ms one of the remaining tabs should open a new `/api/conversations/stream` and continue receiving events. Confirm by triggering another action (rename, delete) and seeing it propagate.
5. Open `chrome://inspect` → service workers / locks (or run `await navigator.locks.query()` in the console) → verify exactly one holder of `singularity:conversations:stream`.
6. Multi-origin sanity check: open `equin.localhost:9000` and `claude-XXX.localhost:9000` simultaneously. Each should have its own leader (different origin = different lock namespace).
7. **Server-restart test:** with several tabs open, run `./equin build` in another worktree. Within ~5s every tab should show the existing "Reconnected to server" toast (driven by `subscribeWsStatus`), and follower tabs' sidebars should re-fetch and reconcile. Verify by deleting a conversation while the server is mid-restart, then confirming the deletion is reflected in all tabs once the new SSE opens.

## Out of scope

- HTTP/2 in the gateway (Phase 2; addresses the per-host cap for *all* requests, not just SSE).
- Migrating the WebSocket channels (`/ws/terminal`, `/ws/logs`) to a similar leader pattern. WS is per-pane today, not a fanout broadcast — different problem.
- Server-side request-timing logs. Worth doing separately, not coupled to this change.
