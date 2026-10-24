# Unified multiplexed SSE stream

## Context

Today the backend has two independent SSE endpoints (`GET /api/conversations/stream`, `GET /api/conversations/:id/edited-files/stream`) and only the first carries a 20s heartbeat. Each URL gets its own TCP connection per browser (via leader-elected `ReconnectingEventSource` — commit `7f056e8`), but across many open tabs and conversations this still multiplies connections and per-endpoint heartbeat logic. A client lint check (`no-raw-event-source`, commit `7f056e8`) already forces every consumer through `ReconnectingEventSource`, which gives us a single choke point to multiplex.

**Goal:** one multiplexed SSE connection per browser with a single, centralized heartbeat. Plugins keep declaring streams as if they were independent endpoints; clients keep calling `new ReconnectingEventSource({ url })` against virtual URLs. The multiplexing is entirely internal to the core — no plugin or consumer is aware of it.

## Design

### Server: `sseRoutes` in the plugin definition

Mirror the existing `httpRoutes` / `wsRoutes` pattern. Add `sseRoutes: Record<string, SseHandler>` to `ServerPluginDefinition` in `server/src/types.ts`:

```ts
export interface SseHandler {
  // Called when a subscriber joins. Return an unsubscribe fn.
  subscribe(
    send: (data: unknown) => void,
    params: Record<string, string>,
  ): () => void;
}
```

Keys use the same syntax as `httpRoutes` (method omitted; `:param` segments supported), e.g. `"/api/conversations/stream"` and `"/api/conversations/:id/edited-files/stream"`. The core reuses `registerHttpRoute` / `matchParamRoute` from `server/src/index.ts` on a parallel `sseLiteral` / `sseParam` table — factor the matcher out so it's shared.

### Server: one real endpoint `/api/events`

Register in `server/src/index.ts` (core, not a plugin). Handler:

1. Read `?urls=<comma-joined, url-encoded virtual urls>` from the request.
2. For each virtual url, match against the `sseRoutes` table → `(handler, params)`.
3. Open a `ReadableStream`. Send `: ok\n\n`, then for each match call `handler.subscribe(send, params)` where `send(data)` enqueues:

   ```
   event: <virtualUrl>
   data: <JSON.stringify(data)>
   \n
   ```

   Using SSE **named events** (keyed by the virtual URL) is the wire-level multiplex key.
4. Central 20s heartbeat (`: ping\n\n`) owned by this route — the only heartbeat in the system.
5. On `cancel`, call every unsubscribe.

Plugin handlers no longer manage their own subscriber sets, response encoding, or heartbeats. They just emit events via `send(...)`.

### Client: transparent multiplex inside `ReconnectingEventSource`

Consumers keep the existing API: `new ReconnectingEventSource({ url: "/api/conversations/stream", onMessage })`. Internally, rewrite `plugin-core/reconnecting-event-source.ts` so that instead of one `Coordinator` per URL each owning an `EventSource`, there is a **single process-wide `Multiplex`** that:

- Holds the set of currently-subscribed virtual URLs (one entry per active `Coordinator`).
- Leader-elects (Web Lock + BroadcastChannel, same mechanism) on the key `sse:multiplex` — not per URL.
- As leader, opens a single `EventSource("/api/events?urls=" + encoded)`.
- Uses `addEventListener(virtualUrl, ev => dispatch(virtualUrl, ev.data))` to route frames to the right `Coordinator` (which still owns per-URL subscribers and broadcasts to follower tabs on channel `sse:${url}` exactly as today).
- When the subscription set changes (new URL, last subscriber for a URL leaves), close the real `EventSource` and reopen with the new `?urls=`. Debounce by a tick to batch mount/unmount churn.
- Heartbeat comments (`: ping`) are ignored by `EventSource` natively; the leader treats `open` / `error` exactly as today (shared status bus).

Follower tabs are unchanged: they still listen on `sse:${url}` BroadcastChannels. The leader re-posts each demuxed event on the matching channel.

### Migration (atomic, no backcompat)

1. Add `SseHandler` + `sseRoutes` to `server/src/types.ts`.
2. Factor the literal/param matcher in `server/src/index.ts` into a small helper and reuse for SSE.
3. Add the `/api/events` core route with the central heartbeat.
4. Convert the two existing emitters:
   - `plugins/conversations/server/internal/sse.ts` — drop `handleStream`, the subscriber set, heartbeat `setInterval`, and the response-level encoding. Keep `broadcast(event)` but route it through a `send` captured at subscribe time. Export `sseRoutes: { "/api/conversations/stream": ... }` from `plugins/conversations/server/index.ts` and delete the `GET` entry from `httpRoutes`.
   - `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-stream.ts` — same: subscribe starts/stops the 1s poll per `conversationId` room; the per-request `ReadableStream` wrapper in `code/server/index.ts` goes away; declare it in `sseRoutes` under `/api/conversations/:id/edited-files/stream`.
5. Rewrite `plugin-core/reconnecting-event-source.ts` as described. Keep the public constructor signature unchanged so call sites (`plugins/.../code/web/use-edited-files.ts`, `plugins/conversations/web/...`) require zero edits.
6. Update the plugin docgen (`cli/src/docgen.ts`) to parse `sseRoutes` alongside `httpRoutes` / `wsRoutes` so `plugins/CLAUDE.md` shows `SSE /api/...` entries. Regenerate the doc.
7. Update `server/CLAUDE.md` to document `sseRoutes`.
8. The existing `no-raw-event-source` check stays as-is — still important since the multiplex lives inside `ReconnectingEventSource`.

## Critical files

- `server/src/types.ts` — add `SseHandler`, `sseRoutes`.
- `server/src/index.ts` — share route matcher, register `/api/events`, central heartbeat.
- `plugin-core/reconnecting-event-source.ts` — swap per-URL `Coordinator` → single `Multiplex` + per-URL demux.
- `plugins/conversations/server/index.ts` + `internal/sse.ts` — convert to `sseRoutes`, drop heartbeat/subscriber plumbing.
- `plugins/conversations/plugins/conversation-view/plugins/code/server/index.ts` + `internal/edited-files-stream.ts` — same conversion.
- `cli/src/docgen.ts` — parse `sseRoutes`.
- `plugins/CLAUDE.md`, `server/CLAUDE.md` — regenerated/updated.

Reuses: `registerHttpRoute` / `matchParamRoute` in `server/src/index.ts:28-70`; Web Locks + `BroadcastChannel` leader pattern already in `plugin-core/reconnecting-event-source.ts`; `publishWsStatus` / `ws-status-bus` stays untouched (status is still keyed per virtual URL for the status UI).

## Verification

1. `./equin build` — app deploys at `http://<worktree>.localhost:9000`.
2. Open the app, open several conversations in multiple tabs. In DevTools → Network, confirm exactly **one** `/api/events?urls=...` EventStream per browser (not per tab, not per URL). Inspect frames: `event: /api/conversations/stream` and `event: /api/conversations/:id/edited-files/stream` interleaved, plus `: ping` every ~20s.
3. Conversation list updates (create/delete/title change) continue to propagate across tabs.
4. Edited-files counter still updates in under ~1s after a file edit in a worktree, in every open tab for that conversation.
5. Close all tabs but one, open a new conversation view → confirm the `urls=` query on `/api/events` updates (connection reopens) to include the new virtual URL.
6. Kill the server (`singularity build` restart) → every tab reconnects via the shared leader; no reconnect storm (commit `b72918d` regression guard still holds).
7. Run `./equin check` — `no-raw-event-source` check passes.
