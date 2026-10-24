# Live State Redesign — REST + WS Notifications + TanStack Query

## Context

Today every "live" feature in the app reaches for SSE. The current
unified `/api/events` multiplex (commit `58a0b95`) was an attempt to
tame the cost of one EventSource per feature, but it carried over the
fundamental SSE constraint that *the URL is immutable* — so adding a
new subscription forces a reconnect of all unrelated streams. That
choice is the root of the user-visible bugs documented in
[`2026-04-15-global-sse-lifecycle-mental-model.md`](./2026-04-15-global-sse-lifecycle-mental-model.md)
(H1 — events lost in reopen gap; H2 — stale React state; H3 — refresh
watcher keyed on the wrong status; H7 — snapshot replays only "working"
truth).

The deeper problem is that every feature is independently solving the
same problem — *keep a client view consistent with server state* — by
hand, on top of a stream-of-events primitive that wasn't designed for
it. Each feature ships its own snapshot replay, its own event reducer,
its own reconnect reconciliation, its own cross-tab fan-out.

This doc proposes replacing the whole SSE-based live-state stack with
**REST for reads + WS for notifications + TanStack Query for the
client cache.** Backend plugins keep writing normal HTTP routes;
frontend plugins stop writing live-state code at all.

Scope assumed: single user, many agents, localhost. Multi-user /
collaborative-editing scale is explicitly out of scope; if that ever
becomes real the path forward is adopting a sync engine
(Replicache/Zero/ElectricSQL), not iterating on this design.

## Goals

1. **One mental model** for live state, declared once per resource.
2. **No reopen-of-unrelated-streams** when a new subscription is added.
3. **Self-healing on reconnect**: client always converges to server
   truth without per-feature reconciliation logic.
4. **Plugin code shrinks**. No `ConversationStreamClient`, no
   `applyEvent` reducers, no `wasReconnecting` watchers, no `live`
   React state to maintain.
5. **Backend changes are small and additive** — existing HTTP routes
   keep working untouched.

## Design

### Three concepts, total

| Concept | Shape | Transport |
|---|---|---|
| **Resource** | Queryable state with a current value (conversation list, edited files, task tree) | HTTP GET + WS notification |
| **Stream** | Append-only firehose where every byte matters (terminal output, log tails) | Dedicated WS (already exists) |
| **Command** | One-shot request/response | HTTP + existing `defineCommand` |

Everything that is currently SSE becomes a **Resource**. Streams and
Commands are unchanged.

### Wire protocol — one endpoint, two message kinds

A single endpoint `GET /ws/notifications` carries server→client
messages of one of two shapes:

```ts
// Inline payload — server pushes the new value of a resource.
// Client cache is updated atomically; no follow-up GET.
{ kind: "update", key: ResourceKey, value: unknown }

// Invalidation — server says "this key is stale, refetch if you care".
// Client re-runs the GET only if a component is currently observing it.
{ kind: "invalidate", key: ResourceKey }
```

Client→server messages manage the subscription set:

```ts
{ op: "sub", key: ResourceKey }
{ op: "unsub", key: ResourceKey }
```

`ResourceKey` is a tuple-ish identifier (e.g. `["conversations"]`,
`["edited-files", id]`) — same shape TanStack Query already uses.

Per-resource the server picks `update` vs `invalidate`:

- **`update`** when the value is small and the same for all viewers
  (conversation list, tasks tree, status badges).
- **`invalidate`** when the value is large, expensive, or per-client
  (edited files for a particular conversation).

The client API is identical for both — it's a transport detail.

### Backend — `defineResource` primitive

A small library next to the existing `httpRoutes`/`wsRoutes` stack.

```ts
// server/src/resources.ts
export function defineResource<T>(
  key: ResourceKey,
  loader: (params: Record<string, string>) => Promise<T>,
  opts?: { mode: "push" | "invalidate" },
): Resource<T>;
```

A `Resource` exposes:

- An HTTP route automatically registered (`GET /api/resources/<key>`).
- `notify(value?)` — call from a poller, a mutation handler, a DB
  trigger. If `mode: "push"`, broadcasts `{kind: "update", value}`. If
  `mode: "invalidate"`, broadcasts `{kind: "invalidate"}`.

Plugins keep declaring normal `httpRoutes` for everything else
(commands, file fetches, etc.). Only "live state" goes through
`defineResource`.

### Frontend — TanStack Query is the only primitive

Add `@tanstack/react-query` to the root `package.json`.

The entire "live" surface area for plugins becomes:

```ts
// In any plugin component:
const { data, isLoading } = useResource(["conversations"]);
```

`useResource` is a thin wrapper around `useQuery`:

```ts
function useResource<T>(key: ResourceKey) {
  return useQuery({
    queryKey: key,
    queryFn: () => fetch(`/api/resources/${encodeKey(key)}`).then(r => r.json()),
  });
}
```

A single `NotificationsClient` (one instance per app, leader-elected
across tabs via Web Lock so only one tab opens the WS) owns:

- The WS connection to `/ws/notifications`.
- Mapping incoming `{kind: "update", key, value}` →
  `queryClient.setQueryData(key, value)`.
- Mapping incoming `{kind: "invalidate", key}` →
  `queryClient.invalidateQueries({ queryKey: key })`.
- Tracking which keys have observers (TanStack Query exposes this
  via `queryClient.getQueryCache().subscribe(...)`) and sending
  `{op: "sub"}` / `{op: "unsub"}` to the server accordingly.
- On reconnect: re-send the current subscription set; invalidate every
  observed key so cached state is reconciled. **Reconnect correctness
  is one line of code, not a per-feature concern.**

### What replaces what

| Today | Tomorrow |
|---|---|
| `SseHandler` plugin abstraction | `defineResource(key, loader)` |
| `/api/events?urls=csv` multiplex | `/ws/notifications` + `/api/resources/<key>` |
| `Multiplex` + `Coordinator` reopen dance | One WS, in-band sub/unsub |
| `ReconnectingEventSource` | TanStack Query's built-in retry/refetch |
| `ConversationStreamClient` (second leader election, BroadcastChannel, liveCache) | Deleted. Cross-tab sync = leader-elected WS + TanStack Query's broadcastQueryClient experimental adapter, *or* simply N-tab independent caches (acceptable for our scope) |
| `useConversationStream` + `live` React state + `applyEvent` reducer | `useResource(["conversations"])` |
| `wasReconnecting` watcher → `refresh()` | Built into TanStack Query reconnect handling |
| Snapshot replay on subscribe + edge events | Server `notify(value)` writes the level value directly |
| Status events `connecting`/`reconnecting`/`open` in feature code | Hidden inside the notifications client |

## Critical files

### Created

- `server/src/resources.ts` — `defineResource`, the `notify` machinery,
  the WS notifications endpoint registration, the auto-registered
  `GET /api/resources/:key` route.
- `plugin-core/notifications-client.ts` — the leader-elected WS client
  that drives TanStack Query's cache.
- `plugin-core/use-resource.ts` — `useResource` + key encoding helpers.

### Modified

- `server/src/types.ts` — add a `resources?:` field to
  `ServerPluginDefinition` (alongside `httpRoutes`/`wsRoutes`).
- `server/src/index.ts` — register resources from each plugin; mount
  `/ws/notifications` and `/api/resources/:key`. Remove `/api/events`
  and the SSE registration code.
- `web/src/App.tsx` — wrap with `<QueryClientProvider>` and
  `<NotificationsProvider>`.
- `package.json` (root) — add `@tanstack/react-query`.
- `plugins/conversations/server/index.ts` — replace
  `conversationsStreamHandler` with
  `defineResource(["conversations"], …, {mode: "push"})`.
- `plugins/conversations/server/internal/poller.ts` — replace
  `broadcast(event)` calls with `conversationsResource.notify(value)`.
  The poller stops emitting edge events; it just re-publishes the
  level state when something changes.
- `plugins/conversations/web/stream/*` — **delete the directory**.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
  — replace `useConversationStream` + `live` state +
  `wasReconnecting` watcher with one `useResource(["conversations"])`
  call.
- `plugins/conversations/plugins/conversation-view/plugins/code/server/internal/edited-files-stream.ts`
  → become an invalidate-mode resource:
  `defineResource(["edited-files", id], loader, {mode: "invalidate"})`.
- `plugins/conversations/plugins/conversation-view/plugins/code/web/use-edited-files.ts`
  — collapse to `useResource(["edited-files", id])`.
- `plugins/tasks/server/internal/sse.ts` →
  `defineResource(["tasks"], …, {mode: "push"})`.
- `plugins/tasks/web/components/tasks-list.tsx` — switch to
  `useResource`.
- `cli/src/checks/no-raw-sse.ts` — repurpose to forbid `defineResource`
  bypass (raw `text/event-stream` writes), or simply remove if the SSE
  code path is gone entirely.

### Deleted

- `plugin-core/reconnecting-event-source.ts`
- The SSE handling block of `server/src/index.ts` (`handleEvents`,
  `literalSseRoutes`, `paramSseRoutes`, `resolveSse`).
- `plugins/conversations/web/stream/` (entire directory).
- Per-plugin `internal/sse.ts` files once their resources are migrated.

## Migration strategy

Migrate one resource at a time. The new and old transports can coexist
during the transition because they don't share state.

1. **Land the primitive** — `defineResource`, `useResource`,
   `NotificationsClient`, `/ws/notifications`,
   `/api/resources/:key`. No plugin uses it yet. Ship and `./equin build`.
2. **Migrate `conversations`** (the highest-pain feature). Verify the
   bugs in the v1 doc are gone. Delete `ConversationStreamClient` and
   `useConversationStream`.
3. **Migrate `tasks`**. Delete `plugins/tasks/server/internal/sse.ts`.
4. **Migrate `edited-files`** (this is the test of `mode: "invalidate"`).
5. **Remove** `/api/events`, `Multiplex`, `ReconnectingEventSource`,
   the `sseRoutes` field from `ServerPluginDefinition`, the
   `no-raw-sse` check (or repurpose).
6. **Update `plugins/CLAUDE.md` and `server/CLAUDE.md`** — document
   `defineResource` / `useResource` as the live-state primitives;
   remove the `SseHandler` documentation.

Each step is independently shippable via `./equin build`.

## Verification

End-to-end checks the redesign must pass:

1. **Open the conversations sidebar.** All currently-active agents
   show as active. Pause one agent (so it transitions to
   non-working); the row updates within ~1s.
2. **Open a second pane while the first agent is working.** The
   first agent's status does *not* flicker, go grey, or lag. (This is
   the H1 regression test — adding a subscription must not disturb
   existing ones.)
3. **Restart the server (`./equin build`).** Within a few
   seconds of the server coming back, every open pane shows
   server-truth state. No stale "working" rows. (H2/H7 regression.)
4. **Force-kill an agent's tmux session externally.** Within a tick
   the conversations row reflects `gone`/`completed` status. (Verifies
   level-state push handles deletions, not just additions.)
5. **Open three browser tabs.** Verify exactly one WS connection to
   `/ws/notifications` exists across all tabs (DevTools → Network).
   Verify state updates fan out to all three tabs.
6. **DevTools Network tab.** Confirm `/api/events` no longer appears.
   Confirm `/ws/notifications` is the only live channel beyond
   terminal/log streams.
7. **TanStack Query devtools** (recommended add). Inspecting the
   conversations query shows it staying fresh, no spurious refetches
   when unrelated panes mount.

If all seven pass, the seven hazards (H1–H7) named in the v1 doc are
structurally eliminated, not merely papered over.
