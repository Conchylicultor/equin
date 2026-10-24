# Conversation Status Toolbar Plugin

## Context

The conversation pane header (`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`) currently shows the session id and a row of action buttons (`Open`, `VSCode`) contributed via the `Conversation.Toolbar` slot. It does not surface the conversation's `status` field (`starting | working | needs_attention | completed | obsolete`) even though the DB schema and `/api/conversations` list response already expose it.

We want a new plugin that contributes a **colored status badge** (display-only) to the conversation toolbar so the user can glance at pane state. Adding it as a plugin — rather than inlining it — keeps with the slot/contribution pattern and makes the toolbar extensible to richer status widgets later.

## Design

### 1. Extend `Conversation.Toolbar` slot to accept a custom component

The slot currently only supports `{ label, icon, onClick }` action buttons. A badge has no onClick and needs conversation data. Mirror `Shell.Toolbar`'s shape by making all fields optional and adding a `component` field that receives the `ConversationState`.

**File:** `plugins/conversations/plugins/conversation-view/web/slots.ts`

```ts
export const Conversation = {
  Toolbar: defineSlot<{
    label?: string;
    icon?: ComponentType<{ className?: string }>;
    onClick?: (conversation: ConversationState) => void;
    component?: ComponentType<{ conversation: ConversationState }>;
    group?: string;
  }>("conversation.toolbar"),
};
```

**File:** `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`
Update the `.map` loop to render `item.component` when present, falling back to the existing `Button` + `label`/`icon`/`onClick` path. Order `status` group before `actions` group by sorting on optional `group`.

### 2. Server: add `:param` support to the router, then expose `GET /api/conversations/:id`

The Bun router in `server/src/index.ts:35` currently matches `METHOD pathname` exactly. `server/CLAUDE.md` documents this as "No dynamic route matching", so this change intentionally relaxes that decision — update the doc alongside the code.

**File:** `server/src/types.ts`
- Broaden `HttpHandler` to `(req: Request, params: Record<string, string>) => Response | Promise<Response>`. Existing handlers ignore the extra arg at call-time; TS-wise, all handlers now accept the optional `params`.

**File:** `server/src/index.ts`
- Replace the flat `httpRoutes` lookup with a small matcher:
  1. On plugin registration, split each route key `"METHOD /a/:b/c"` into `{ method, segments: ["a", { param: "b" }, "c"], handler }` and push into an array.
  2. In `fetch`, split `url.pathname` and linearly match against the array: literal segments must equal, `:param` segments capture. First match wins.
  3. Keep an O(1) fast path for fully-literal routes (store them in a Record keyed by `"METHOD pathname"` and check that first) so existing routes keep their current performance profile.
- Pass the captured `params` into the handler.

**File:** `server/CLAUDE.md`
- Update the "Key Design Decisions" bullet: the router now supports `:param` segments; plugins should still own their sub-paths where the shape isn't a simple id.

**File:** `plugins/conversations/server/internal/handle-get.ts` (new)
- `(req, params) => ...`; look up by `params.id` via the existing `listConversations()` helper (`server/internal/tmux.ts`) and return the single `Conversation` object (404 if missing).

**File:** `plugins/conversations/server/index.ts`
- Register `"GET /api/conversations/:id": handleGet`.

### 3. New plugin: `conversation-status`

**Location:** `plugins/conversations/plugins/conversation-view/plugins/status/`

```
status/
  web/
    index.ts
    components/
      status-badge.tsx
  package.json
```

**`web/index.ts`** — contribute `Conversation.Toolbar({ component: StatusBadge, group: "status" })`.

**`web/components/status-badge.tsx`**:
- Props: `{ conversation: ConversationState }`
- On mount & when `conversation.id` changes: `fetch(\`/api/conversations/${conversation.id}\`)` → `Conversation` (mirrors pattern at `conversations-view/web/components/conversation-list.tsx:37`).
- Render a colored pill using the existing shadcn `Badge` component (`@/components/ui/badge`) with status→color mapping:
  - `starting` → neutral/secondary
  - `working` → blue
  - `needs_attention` → amber/destructive
  - `completed` → green
  - `obsolete` → muted
- Show the status text (replace `_` with space).

Reuse the shared `Conversation` / `ConversationStatus` types from `plugins/conversations/shared/types.ts`.

### 4. Register the new plugin

**File:** `web/` plugin registry (find the registry via the pattern already used by `open-app` / `vscode` sibling plugins and add the new plugin id alongside).

**File:** `plugins/CLAUDE.md` — add an entry under `conversation-view` → plugins listing `conversation-status`.

## Files to Modify / Create

Modify:
- `plugins/conversations/plugins/conversation-view/web/slots.ts`
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`
- `plugins/conversations/server/index.ts`
- `server/src/index.ts`
- `server/src/types.ts`
- `server/CLAUDE.md`
- `plugins/CLAUDE.md`
- Web plugin registry (wherever `open-app`/`vscode` are registered)

Create:
- `plugins/conversations/server/internal/handle-get.ts`
- `plugins/conversations/plugins/conversation-view/plugins/status/package.json`
- `plugins/conversations/plugins/conversation-view/plugins/status/web/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/status/web/components/status-badge.tsx`

## Verification

1. `./equin build` — ensures types compile, server restarts, no migration drift.
2. `curl http://<worktree>.localhost:9000/api/conversations/<known-id>` returns a single conversation JSON, and the existing `GET /api/conversations` list still works (literal-route fast path intact). with a `status` field.
3. Open `http://<worktree>.localhost:9000/c/<known-id>` in the browser — toolbar shows a colored badge matching the status. Verify the existing `Open` / `VSCode` buttons still render (slot backward-compat).
4. Playwright screenshot to confirm visual:
   ```
   bunx playwright screenshot --wait-for-timeout 3000 --viewport-size "1280,800" \
     http://<worktree>.localhost:9000/c/<id> /tmp/status.png
   ```
