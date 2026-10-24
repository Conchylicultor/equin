# Conversations sidebar list — refactor into cleaner abstractions

## Context

`plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` has grown into a ~212-line component that mixes five concerns: programmatic route navigation, pathname-derived active state, list CRUD, SSE merging for two distinct event families (list mutations vs. runtime presence), and presentation.

Most visibly, it had a bug where newly created conversations weren't selected in the list. Root cause: `Shell.OpenPane` in `plugins/shell/web/components/shell-layout.tsx:83-89` calls `history.pushState` but never dispatches any event, yet `conversation-list.tsx:50-58` already listens for a `shell:navigate` event that nothing emits. A manual `setActiveId` workaround was added in both the click handler and create handler — treating the symptom.

This refactor fixes the root cause and pulls the remaining concerns into dedicated hooks/components so the list component becomes presentation-only and the abstractions are reusable by future sidebars (agents, worktrees, etc.).

Out of scope: the `claude-session` SSE event (already unhandled in the list today — leave as-is), server-side changes, multi-tab `BroadcastChannel` coordination (already owned by the stream client).

## Target layout

New files:

- `plugins/shell/web/use-route-param.ts` — `useRouteParam(pattern)` hook.
- `plugins/conversations/web/use-conversations.ts` — `useConversations()` hook.
- `plugins/conversations/web/use-conversation-live.ts` — `useConversationLive()` hook.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list-item.tsx` — `<ConversationListItem>` component.

Modified files:

- `plugins/shell/web/components/shell-layout.tsx` — dispatch `shell:navigate` in `OpenPane`.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — slim down to presentation.

File placement follows existing repo convention (hooks colocated in `web/`, no `/hooks` directory).

## Step-by-step

### 1. Dispatch `shell:navigate` from `Shell.OpenPane`

In `plugins/shell/web/components/shell-layout.tsx:83-89`, after `history.pushState(...)`, dispatch a typed event:

```ts
window.dispatchEvent(new CustomEvent("shell:navigate"));
```

Existing `popstate` listener at lines 109-122 keeps its current role (back/forward only). No double-fire: `pushState` does not emit `popstate`.

Delete the manual `setActiveId(conversation.id)` workarounds in `conversation-list.tsx` — they're made redundant by the event (and will be deleted anyway by step 5).

### 2. Add `useRouteParam(pattern)` in shell plugin

New file `plugins/shell/web/use-route-param.ts`. Pattern matches the style already used by `matchRoute` in `plugins/shell/web/routing.ts`; reuse it if the signatures line up, otherwise take a plain regex/string pattern and extract the first capture. API:

```ts
function useRouteParam(pattern: string): string | null
```

Internals: `useState` initialized from `window.location.pathname`, `useEffect` subscribing to both `popstate` and `shell:navigate`, sync callback re-matches the pathname. Returns the decoded capture.

Replaces `activeIdFromPath` + the `useEffect` + `activeId` state in `conversation-list.tsx:37-58`. Caller site:

```ts
const activeId = useRouteParam("/c/:id");
```

### 3. Add `useConversations()` in conversations plugin

New file `plugins/conversations/web/use-conversations.ts`. Owns:

- `conversations` state (array).
- `loading` state.
- Initial `refresh()` via `GET /api/conversations` + `ConversationSchema` zod parse (current `conversation-list.tsx:60-72`).
- SSE merging for `created`, `deleted`, `title` events via `useConversationStream` from `plugins/conversations/web/stream/use-conversation-stream.ts` (current lines 74-85, 87).
- Reconnect-triggered refresh via `subscribeWsStatus` from `@core` (current lines 104-116).
- `create()` — `POST /api/conversations`, returns the parsed Conversation. No direct routing — the caller decides what to do (list item will call `Shell.OpenPane`).
- `remove(id)` — `DELETE /api/conversations?name={id}` then `refresh()` (current lines 124-131).

Return shape: `{ conversations, loading, refresh, create, remove }`.

### 4. Add `useConversationLive()` in conversations plugin

New file `plugins/conversations/web/use-conversation-live.ts`. Owns `live: Record<string, RuntimeLive>` driven by `idle` and `gone` SSE events (current lines 88-99). Uses its own `useConversationStream` subscription — stream client already supports multiple subscribers. Returns the record directly.

Kept strictly separate from `useConversations` so presence updates don't churn list state and the two hooks can be composed (or used) independently.

### 5. Extract `<ConversationListItem>`

New file `plugins/conversations/plugins/conversations-view/web/components/conversation-list-item.tsx`. Props:

```ts
{
  conversation: Conversation;
  live: RuntimeLive | undefined;
  active: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}
```

Owns: indicator dot, label (`conversation.title ?? "Idle"`), relative time via `formatRelativeTime` (move the helper to this file), `SidebarMenuItem`/`SidebarMenuButton`/`SidebarMenuAction` markup, and the `order` style for idle vs. active grouping.

### 6. Slim down `ConversationList`

After steps 2–5, the component becomes:

```tsx
export function ConversationList() {
  const activeId = useRouteParam("/c/:id");
  const { conversations, loading, refresh, create, remove } = useConversations();
  const live = useConversationLive();

  const handleCreate = async () => {
    const conv = await create();
    Shell.OpenPane(conversationPane({ session_id: conv.id }));
  };
  const handleOpen = (id: string) =>
    Shell.OpenPane(conversationPane({ session_id: id }));

  return (
    /* header (New / Refresh buttons) + SidebarMenu mapping ConversationListItem */
  );
}
```

No more `activeIdFromPath`, no more direct `fetch`/`zod`/stream wiring, no more `setActiveId` workarounds.

## Order of changes

1. Step 1 (dispatch `shell:navigate`) — lands the bug fix as a one-line change; safe to verify in isolation.
2. Step 2 (`useRouteParam`) — consume it from `conversation-list.tsx`; delete `activeIdFromPath` + listener `useEffect` + manual `setActiveId` calls.
3. Step 3 (`useConversations`) — swap it in; delete fetch/stream/reconnect blocks from the component.
4. Step 4 (`useConversationLive`) — swap it in; delete the tmux branch of the SSE switch.
5. Step 5 (`<ConversationListItem>`) — extract; the component is now presentation + a tiny header.

Each step keeps `conversation-list.tsx` compiling and the app working — they can be landed as separate commits if desired.

## Critical files

- `plugins/shell/web/components/shell-layout.tsx:83-89` — add dispatch.
- `plugins/shell/web/routing.ts` — check if `matchRoute` can back `useRouteParam`.
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — shrinks.
- `plugins/conversations/web/stream/use-conversation-stream.ts` — reused as-is.
- `plugins/conversations/shared/protocol.ts` — SSE event union (reference only).
- `plugin-core/ws-status-bus.ts` — `subscribeWsStatus` (reused as-is).

## Risks

- **Event double-fire.** Verified: `pushState` does not fire `popstate`, so dispatching `shell:navigate` alongside `popstate` listening is safe. Other plugins currently dispatch `shell:navigate` nowhere; only `conversation-list.tsx` listens. Grep before landing to confirm.
- **Reconnect race.** `useConversations` and `useConversationLive` both react to SSE reconnects. `useConversations` refetches the list; `useConversationLive` can either clear its map on reconnect or rely on the next `idle`/`gone` burst. Recommend clearing on reconnect to match current behavior (stale presence would linger otherwise — double-check against current code, which doesn't clear).
- **Stream subscriber count.** Splitting into two `useConversationStream` calls means two subscribers. Confirm `ConversationStreamClient` handles multi-subscriber correctly (agent report implies yes; verify in `plugins/conversations/web/stream/client.ts`).
- **Route pattern parsing.** `useRouteParam("/c/:id")` must agree with `matchRoute` semantics used elsewhere. Prefer reusing `matchRoute` over rolling a parallel regex.
- **`claude-session` event.** Currently unhandled; keep it unhandled. Don't let the refactor accidentally start reacting to it.

## Verification

1. `./equin build` and load `http://claude-1776140275.localhost:9000`.
2. Click "New conversation" → verify the new row appears in the sidebar **and is highlighted** (the original bug).
3. Click another conversation → verify selection moves.
4. Use browser back/forward → verify selection follows.
5. Start a Claude session in a conversation → verify the live dot turns active (non-idle) and ordering puts non-idle on top.
6. Restart the server (`./equin build` again) → verify the list refetches and presence recovers after SSE reconnect.
7. Delete a conversation → verify it disappears.
8. Open devtools → confirm exactly one `shell:navigate` dispatch per `OpenPane` call, no errors.
