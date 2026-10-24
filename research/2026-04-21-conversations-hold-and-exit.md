# Hold and Exit Button

## Context

The conversation toolbar has two exit actions today:
- **Drop & Exit** — abandons the task (marks it `dropped`) and kills the conversation
- **Push & Exit** — asks Claude to push to main, then closes the conversation

There is no lightweight "park this for later" action. "Hold & Exit" fills that gap: it marks the task as `held` (preserving it for resumption) and kills the conversation runtime, without pushing or dropping anything.

The `held` task status and `hold: true` patch already exist in `tasks-core` — this is purely additive UI + a thin server route.

---

## Implementation Plan

### New plugin: `plugins/conversations/plugins/hold-and-exit/`

Structure mirrors `drop-and-exit` exactly (the simplest exit pattern):

```
hold-and-exit/
├── package.json
├── web/
│   ├── index.ts
│   └── components/
│       └── hold-and-exit-button.tsx
└── server/
    └── index.ts
```

---

### `package.json`

```json
{
  "name": "@singularity/plugin-hold-and-exit",
  "private": true,
  "version": "0.0.1"
}
```

---

### `web/index.ts`

Contribute to `Conversation.Toolbar` in the `floating` group (same as drop/push).

```typescript
export default {
  id: "conversation-hold-and-exit",
  name: "Conversation: Hold & Exit",
  description: "Toolbar button that marks the task as held and closes the conversation.",
  contributions: [Conversation.Toolbar({ component: HoldAndExitButton, group: "floating" })],
} satisfies PluginDefinition;
```

---

### `web/components/hold-and-exit-button.tsx`

- Fetches `POST /api/conversations/:id/hold-and-exit`
- Disabled when `busy || status === "gone" || status === "starting"`
- Success toast: "Task held — conversation closed"
- Error toast on failure
- Icon: `PauseCircle` from lucide-react (conveys "paused, not done")
- Styling: default variant (neutral, not destructive red)

---

### `server/index.ts`

Thin route — same shape as `drop-and-exit/server/index.ts`:

```
POST /api/conversations/:id/hold-and-exit
  1. getConversation(id)                         → tasks-core
  2. updateTask(conversation.taskId, { hold: true })  → tasks-core
  3. deleteConversation(id)                      → conversations/server (kills runtime)
  4. conversationsResource.notify()             → conversations/server
  5. return Response.json({ ok: true })
```

No async job runner needed (synchronous, like drop-and-exit).

---

### Registration

**`web/src/plugins.ts`** — add import and entry:
```typescript
import conversationHoldAndExitPlugin from "@plugins/conversations/plugins/conversation-view/plugins/hold-and-exit/web";
// add to plugins array after conversationDropAndExitPlugin
```

**`server/src/plugins.ts`** — add import and entry:
```typescript
import holdAndExitPlugin from "@plugins/conversations/plugins/conversation-view/plugins/hold-and-exit/server";
// add to plugins array after dropAndExitPlugin
```

---

### Key files to reference

| File | Purpose |
|------|---------|
| `plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/` | Template — copy structure |
| `plugins/tasks-core/server/internal/mutations/tasks.ts` | `updateTask` + `UpdateTaskPatch` (`hold: true`) |
| `plugins/conversations/server/internal/lifecycle.ts` | `deleteConversation` |
| `plugins/conversations/server/index.ts` | `conversationsResource` export |
| `web/src/plugins.ts` | Web plugin registry |
| `server/src/plugins.ts` | Server plugin registry |

---

## Verification

1. `./equin build` — no build errors
2. Open a conversation, confirm "Hold & Exit" button appears in the floating bar
3. Click it — conversation closes, toast confirms success
4. Navigate to Tasks — the task status shows `held` (not dropped, not active)
5. Confirm no regression on Drop & Exit and Push & Exit buttons
