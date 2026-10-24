# Attempt View — basic

## Context

Today, conversations are reachable individually at `/c/:convId`, and a list of all conversations lives in the global sidebar. There is no way to see *just the conversations that belong to a given attempt* alongside the conversation itself. Attempts often span multiple conversations (forks, resumes, etc.) and users currently have to hunt for sibling conversations across the global list.

Goal: add a new "Attempt view" main pane at `/a/:id` with a left pane listing the attempt's conversations and a right pane showing the selected conversation. Add a toolbar button on the standalone conversation view that opens this attempt view, with a counter showing how many conversations belong to the attempt.

This is the basic, minimum-viable version — no new backend work, no new resources, no extra polish. We reuse existing primitives end-to-end.

## Reuse — no new backend code

Everything we need already exists:

- `attemptsResource` (`plugins/tasks-core/server/internal/resources.ts:48`, exported as `tasksResource`-style descriptor at `plugins/tasks/shared/resources.ts`) — push-mode resource yielding `AttemptWithConversations[]`. Each item is `Attempt & { conversations: ConversationSummary[] }` where summary is `{ id, title, status }` (`plugins/tasks-core/shared/index.ts:26-29`). This gives us both:
  - The conversation list for `attemptPane`
  - The conversation count for the toolbar button counter
- `Conversation.attemptId` is on the shared `Conversation` type (`plugins/tasks-core/server/internal/schema.ts:222-233`), so the toolbar button can read it from the `ConversationRecord` prop without any extra fetch.
- `ConversationView` (`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:56`) is already designed to be reused inside a nested pane — `taskConversationPane` does exactly this (`plugins/tasks/web/panes.tsx:132-135`).
- `Pane.define` parent/child + `<Outlet/>` + `usePaneMatch` — covered by the `pane` plugin.

## Plan

### 1. New plugin `plugins/attempt-view/`

Web-only plugin. Three files plus barrel:

```
plugins/attempt-view/
├── package.json
├── web/
│   ├── index.ts                      # PluginDefinition default-export
│   ├── panes.tsx                     # attemptPane + attemptConversationPane
│   └── components/
│       ├── attempt-pane.tsx          # left list + Outlet right
│       ├── attempt-conversation.tsx  # wraps ConversationView
│       └── attempt-switch-button.tsx # Conversation.Toolbar contribution
```

#### `web/panes.tsx`

Mirror the `tasks/web/panes.tsx` pattern (parent pane with list + nested conversation child):

```typescript
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { AttemptPane } from "./components/attempt-pane";
import { AttemptConversationBody } from "./components/attempt-conversation";

export const attemptPane = Pane.define({
  id: "attempt",
  path: "/a/:attemptId",
  component: AttemptPane,
});

export const attemptConversationPane = Pane.define({
  id: "attempt-conversation",
  parent: attemptPane,
  path: "c/:convId",
  component: AttemptConversationBody,
  chrome: { history: true, expand: ({ convId }) => `/c/${convId}` },
});
```

URLs:
- `/a/<attemptId>` → list only, right pane shows "Select a conversation" placeholder.
- `/a/<attemptId>/c/<convId>` → list + selected conversation.

#### `web/components/attempt-pane.tsx`

- `useResource(attemptsResource)` to get `AttemptWithConversations[]`, find the matching attempt by `attemptId` from `attemptPane.useParams()`.
- Left: render `attempt.conversations` (id/title/status only) as a clickable list, calling `attemptConversationPane.open({ attemptId, convId })` on click.
- Right: `<Outlet/>` if a child pane is in the chain (detect via `usePaneMatch`), else a "Select a conversation" placeholder.
- Use `ResizablePanelGroup` (`@/components/ui/resizable`) for the split — same as `TasksRoot` in `plugins/tasks/web/panes.tsx:51-77`.
- Highlight the selected conversation by comparing against the `convId` in the pane match chain (same lookup pattern as `TasksRoot`).
- Use `CONV_STATUS_DOT` (re-exported from `plugins/conversations/web`) for status dots — keeps visual consistency with the sidebar conversation list.

#### `web/components/attempt-conversation.tsx`

Trivial — copy `TaskConversationBody` (`plugins/tasks/web/panes.tsx:132-135`):

```typescript
export function AttemptConversationBody() {
  const { convId } = attemptConversationPane.useParams();
  return <ConversationView key={convId} sessionId={convId} />;
}
```

Known limitation: `ConversationView` only mounts side sub-panes (tasks/jsonl/docs) when the chain contains `conversationPane._internal` (see `conversation-view.tsx:71-76`). Inside `attemptConversationPane`, those toggles will appear in the toolbar but won't open right-side panes — same behavior as today's `taskConversationPane`. Acceptable for "basic"; can be improved later if needed.

#### `web/components/attempt-switch-button.tsx`

Toolbar button contributed to `Conversation.Toolbar` (slot props: `{ conversation: ConversationRecord }`).

Behavior:
- Counter: `useResource(attemptsResource).data?.find(a => a.id === conversation.attemptId)?.conversations.length ?? 0`. Render as small badge next to icon.
- `usePaneMatch()` to detect "are we already in attempt view?" via `attemptPane._internal` in chain (same pattern as `TasksButton` in `plugins/conversations/plugins/conversation-view/plugins/tasks-panel/web/components/tasks-button.tsx:7-32`).
- onClick:
  - If already in attempt view → `conversationPane.open({ convId: conversation.id })` (navigate back to standalone).
  - Else → `attemptConversationPane.open({ attemptId: conversation.attemptId, convId: conversation.id })`.
- Pressed/active styling via `variant={isOpen ? "secondary" : "ghost"}` and `aria-pressed`, same as `TasksButton`.
- Hide the button entirely when count ≤ 1 — opening the attempt view to look at one conversation is busywork. (Cheap to add; matches "basic" spirit.)

#### `web/index.ts`

```typescript
import type { PluginDefinition } from "@core";
import { Conversation } from "@plugins/conversations/plugins/conversation-view/web";
import { AttemptSwitchButton } from "./components/attempt-switch-button";
import "./panes";

export { attemptPane, attemptConversationPane } from "./panes";

export default {
  id: "attempt-view",
  name: "Attempt View",
  description:
    "Main pane at /a/:id showing an attempt's conversations on the left and the selected conversation on the right. Adds a toolbar button to the conversation view to switch into it.",
  contributions: [Conversation.Toolbar({ component: AttemptSwitchButton })],
} satisfies PluginDefinition;
```

#### `package.json`

Match shape of any existing nested plugin's `package.json` (e.g. `plugins/tasks-panel`'s parent or `plugins/welcome/`). Just `name`, `private`, no extra deps — react/icons come from the workspace root.

### 2. Register in web plugin registry

Add to `web/src/plugins.ts` alongside the existing imports + array entry:

```typescript
import attemptViewPlugin from "@plugins/attempt-view/web";
// ...
export const plugins: PluginDefinition[] = [
  // ...existing entries
  attemptViewPlugin,
];
```

No server registry change (web-only plugin).

### 3. Update `docs/plugins.md`

The `plugins-doc-in-sync` check (per CLAUDE.md) keeps `docs/plugins.md` aligned with each plugin's public exports. Add a new entry for `attempt-view` covering its exports (`attemptPane`, `attemptConversationPane`) and contributions (`Conversation.Toolbar`). The exact format is enforced by the check — running `./equin check` will flag any drift.

## Files modified / created

**Created:**
- `plugins/attempt-view/package.json`
- `plugins/attempt-view/web/index.ts`
- `plugins/attempt-view/web/panes.tsx`
- `plugins/attempt-view/web/components/attempt-pane.tsx`
- `plugins/attempt-view/web/components/attempt-conversation.tsx`
- `plugins/attempt-view/web/components/attempt-switch-button.tsx`

**Modified:**
- `web/src/plugins.ts` — register `attemptViewPlugin`.
- `docs/plugins.md` — add the `attempt-view` entry.

**Not modified:** no server changes, no schema/migration, no new resource.

## Verification

1. `./equin build` from this worktree — must succeed (build + plugin-boundaries check + plugins-doc-in-sync check).
2. Navigate to `http://<worktree>.localhost:9000`. Open a conversation that's part of an attempt with ≥2 conversations.
3. Confirm the new toolbar button appears with a count badge matching the number of conversations in that attempt. Click it → URL becomes `/a/<attemptId>/c/<convId>`, left pane shows the conversation list with the current one highlighted, right pane shows the conversation.
4. Click another conversation in the left list → URL updates to `/a/<attemptId>/c/<otherConvId>`, right pane swaps to that conversation.
5. Click the toolbar button again → URL goes back to `/c/<convId>`, attempt view goes away.
6. Open `/a/<attemptId>` directly with no `convId` → list visible, right pane shows the placeholder.
7. Optional Playwright check via `bun e2e/screenshot.mjs` to capture before/after of the toolbar button.
