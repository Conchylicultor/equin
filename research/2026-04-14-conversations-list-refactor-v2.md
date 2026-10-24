# Conversations sidebar list — refactor (v2, API-design lens)

## Context

Same problem as v1: `conversation-list.tsx` mixes routing, list CRUD, two SSE event families, and presentation in one ~212-line component. v1 fixed the bug (no `shell:navigate` dispatcher) and proposed extracting React hooks colocated with the consumer.

v2 redesigns from the API-design lens: start with the end-user code, layer the architecture, and put the public surface alongside `Shell.OpenPane` so the plugin's namespace ergonomics stay symmetric (imperative actions + subscription hooks under one name).

Key shifts vs. v1:

- The route subscription is published on the shell's namespace as `Shell.useCurrentRoute(pattern)` (and a vanilla `Shell.subscribeToRoute(cb)` underneath), not as a free hook in some local file. Hides the `shell:navigate` event name behind shell's API.
- The conversations domain is published as a `Conversations` namespace exposing both *actions* (`create`, `delete`, `refresh`) and *subscriptions* (`useAll`, `useLoading`). Mirrors the `Shell.OpenPane` / `Shell.useCurrentRoute` pattern.
- `Conversation` and runtime presence (`idle`) are merged at the API boundary into a single `LiveConversation` view type. Consumers don't do the lookup dance.
- A single internal store backs both SSE families and the reconnect refresh, so the two-hook split from v1 collapses into one merged subscription. `useSyncExternalStore` is the React adapter.

## End-user code (the aspiration)

```tsx
// plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx
import { Shell } from "@plugins/shell/web";
import { Conversations } from "@plugins/conversations/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web/views";

export function ConversationList() {
  const activeId = Shell.useCurrentRoute("/c/:id");
  const conversations = Conversations.useAll();
  const loading = Conversations.useLoading();

  const handleCreate = async () => {
    const conv = await Conversations.create();
    Shell.OpenPane(conversationPane({ session_id: conv.id }));
  };

  return (
    <div className="flex flex-col gap-1">
      <ConversationListHeader
        loading={loading}
        onCreate={handleCreate}
        onRefresh={Conversations.refresh}
      />
      <SidebarMenu>
        {conversations.map((c) => (
          <ConversationListItem
            key={c.id}
            conversation={c}
            active={c.id === activeId}
            onOpen={() => Shell.OpenPane(conversationPane({ session_id: c.id }))}
            onDelete={() => Conversations.delete(c.id)}
          />
        ))}
        {conversations.length === 0 && !loading && <EmptyState />}
      </SidebarMenu>
    </div>
  );
}
```

Every line maps to one high-level action: subscribe, render, dispatch. No `fetch`, no zod, no event listeners, no manual `setActiveId`, no SSE switch, no level-of-abstraction mixing.

## Public API surfaces

### `Shell` (additions)

```ts
namespace Shell {
  // existing
  function OpenPane(descriptor: PaneDescriptor): string;
  function Toast(...): void;

  // new
  function subscribeToRoute(cb: (pathname: string) => void): () => void;
  function useCurrentRoute<P extends string>(pattern: P): string | null;
}
```

- `subscribeToRoute` is framework-agnostic. Listens to `popstate` + the (now-private) `shell:navigate` event. Returns an unsubscribe.
- `useCurrentRoute(pattern)` is the React adapter. Returns the first capture (matching today's `activeIdFromPath` behavior) or `null`. Built on `subscribeToRoute` + `matchRoute` (existing `plugins/shell/web/routing.ts`).
- `Shell.OpenPane`'s handler dispatches `shell:navigate` after `history.pushState`. The event name stays internal — no other plugin needs to know it exists.

Why a vanilla `subscribe` *and* a hook: the framework already explicitly distinguishes "no lifecycle hooks — plugins use React's own lifecycle" (plugin-core/CLAUDE.md). Vanilla subscribe keeps the contract usable from non-React code (future stores, workers); the hook is sugar on top.

Why not a `defineCommand`: commands are one-shot request-response (`Args → Return`). A continuous subscription with an unsubscribe handle doesn't fit that shape. `subscribeToRoute` is a plain exported function, sitting alongside (not inside) the commands module — same pattern used today for view factories.

### `Conversations` (new)

```ts
namespace Conversations {
  // domain types
  type LiveConversation = Conversation & RuntimeLive; // { id, title, createdAt, ..., idle }

  // subscriptions
  function useAll(): LiveConversation[];
  function useLoading(): boolean;

  // actions
  function create(): Promise<Conversation>;
  function delete(id: string): Promise<void>;
  function refresh(): Promise<void>;
}
```

- `useAll` returns conversations sorted server-order, with `idle` merged from the runtime presence stream. Consumers no longer maintain a parallel `live` map.
- `create`/`delete`/`refresh` are plain async functions — same shape as `Shell.OpenPane`. They mutate the internal store; subscribers re-render.
- `create` does not navigate. Composition is the caller's job: `await Conversations.create(); Shell.OpenPane(...)`. Keeps the conversations plugin free of routing concerns.

## Layered architecture

```
Public API:    plugins/shell/web/index.ts        → Shell namespace
               plugins/conversations/web/index.ts → Conversations namespace
                            │
Domain types:  shared/types.ts (Conversation, RuntimeLive, LiveConversation)
                            │
Operations:    plugins/conversations/web/store.ts
                 ─ subscribe to SSE, merge events, reconnect refresh
                 ─ POST/DELETE actions
               plugins/shell/web/navigation.ts
                 ─ subscribeToRoute, internal notifyRoute()
                            │
Utilities:     plugins/shell/web/routing.ts (matchRoute — existing, reused)
               plugins/conversations/web/stream/* (existing, reused)
               plugin-core/ws-status-bus (subscribeWsStatus — existing, reused)
```

Each layer depends only on the layer below.

## Files

### New

- `plugins/shell/web/navigation.ts` — `subscribeToRoute`, internal `notifyRoute()`. Owns the `shell:navigate` event end-to-end.
- `plugins/shell/web/use-current-route.ts` — `useCurrentRoute(pattern)` hook (React adapter, ~10 LOC).
- `plugins/shell/web/index.ts` — barrel re-exporting the `Shell` namespace (currently no barrel; consumers import from `commands`/`slots` directly). Adds the canonical entry point.
- `plugins/conversations/web/store.ts` — module-level state, SSE wiring, mutations, reconnect refresh. Internal — not re-exported.
- `plugins/conversations/web/conversations.ts` — public `Conversations` namespace (hooks + actions), composed over `store.ts`.
- `plugins/conversations/web/index.ts` — barrel re-exporting `Conversations`.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list-item.tsx` — presentation: dot, label, relative time, delete action.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list-header.tsx` — presentation: New + Refresh buttons.

### Modified

- `plugins/shell/web/components/shell-layout.tsx` — `OpenPane` calls `notifyRoute()` after `history.pushState`. The `popstate` listener at lines 109-122 also calls `notifyRoute()` (single source of truth for navigation events).
- `plugins/shell/web/commands.ts` — unchanged; `OpenPane` stays where it is. The `Shell` namespace barrel re-exports it alongside the new APIs.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — slimmed to the aspirational version above.
- `plugins/CLAUDE.md` — document the new public surfaces under shell + conversations.

### Deleted

- `formatRelativeTime` moves into `conversation-list-item.tsx` (only consumer).
- `activeIdFromPath`, the `useEffect` listener, and the manual `setActiveId` calls — all subsumed by `Shell.useCurrentRoute`.

## Implementation notes

- **Store shape:** `{ conversations: Conversation[]; live: Record<id, RuntimeLive>; loading: boolean }`. `useAll` returns a derived `LiveConversation[]` via `useSyncExternalStore`'s selector — re-run only when the underlying state version changes. Memoized derivation to avoid tear.
- **Lazy SSE subscription:** the store subscribes to `useConversationStream` and `subscribeWsStatus` on first React subscriber, tears down on last unsubscribe. Avoids open sockets when no UI mounts the data.
- **Reconnect:** `subscribeWsStatus` triggers `refresh()` on `reconnecting → open`. Also clear `live` on reconnect (current code doesn't — minor latent bug carried over from v1 analysis).
- **Multi-subscriber stream:** v1 risk is gone — only one stream subscriber (the store), regardless of how many `useAll` callers exist.
- **Out of scope:** the `claude-session` SSE event stays unhandled (matches today). Server-side untouched.

## Order of changes

Each step keeps the app green and is independently shippable.

1. **Shell navigation API.** Add `navigation.ts`, dispatch `notifyRoute()` from `OpenPane` and the existing `popstate` handler. Add `use-current-route.ts`. Add `Shell` barrel. — *fixes the original bug, no consumer changes yet.*
2. **Switch the list to `Shell.useCurrentRoute`.** Delete `activeIdFromPath`, the listener `useEffect`, and the manual `setActiveId` calls.
3. **Conversations store + namespace.** Add `store.ts` and `conversations.ts`. Doesn't touch the component yet (parallel API).
4. **Switch the list to `Conversations`.** Delete the in-component fetch, zod parse, SSE switch, reconnect block, and `live` state.
5. **Extract `<ConversationListItem>` and `<ConversationListHeader>`.** Component becomes presentation-only.
6. **Update `plugins/CLAUDE.md`.**

## Critical files

- `plugins/shell/web/components/shell-layout.tsx:83-89, 109-122` — wire `notifyRoute`.
- `plugins/shell/web/routing.ts` — reused by `useCurrentRoute`.
- `plugins/conversations/web/stream/use-conversation-stream.ts` — single subscriber inside the store.
- `plugin-core/ws-status-bus.ts` — `subscribeWsStatus`, used by reconnect refresh.
- `plugins/conversations/shared/types.ts` — extend with `LiveConversation = Conversation & RuntimeLive`.

## Risks

- **Naming collision.** Today consumers import `Shell` from `@plugins/shell/web/commands` and `Shell` (slot version) from `@plugins/shell/web/slots`. The new barrel `@plugins/shell/web` must merge both into one `Shell` namespace, or we add a third name. Recommend the merge — slots already share the `Shell` name today, so it's purely a re-export consolidation. Audit all existing `import { Shell } from "@plugins/shell/web/..."` sites.
- **`useSyncExternalStore` selector identity.** Returning a freshly-derived `LiveConversation[]` each render breaks tear-free reads. Use a memoized selector keyed on `(conversations, live)` references, recomputed only on store change.
- **Lazy subscription teardown race.** If the last subscriber unmounts and a new one mounts in the same tick, we shouldn't close + reopen the SSE. Use a microtask delay on teardown, or refcount with a small grace period.
- **Barrel circular imports.** `index.ts` re-exporting from `commands.ts` and `navigation.ts` — make sure neither imports from `index.ts`.
- **Behavioral parity.** The current SSE handler is order-sensitive (`created` may arrive before the initial `GET` resolves). The store needs the same dedupe (`prev.some((c) => c.id === conv.id)`).

## Verification

1. `./equin build`, load `http://claude-1776140275.localhost:9000`.
2. **New conversation is selected** — click "New conversation", row appears highlighted.
3. **Click selection** — clicking another row updates the highlight.
4. **Back/forward** — selection follows browser history.
5. **Live presence** — start a Claude session, dot turns active, ordering pushes non-idle to top.
6. **Reconnect** — `./equin build` again, list refetches, presence recovers.
7. **Delete** — row disappears.
8. **Devtools** — exactly one SSE subscription regardless of how many list mounts; one `shell:navigate` dispatch per `OpenPane`.
9. **Type check** — `bun run tsc -b` passes; verify all existing `Shell` consumers still resolve through the new barrel.
