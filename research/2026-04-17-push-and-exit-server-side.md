# Push & Exit — Server-Side Background Job

## Context

The current Push & Exit button is a client-side state machine. It sends a turn,
watches `conversation.status` transitions, fetches the transcript, interprets the
sentinel token, and closes the conversation — all while the component is mounted.
If the user navigates to another pane or a non-conversation route, the component
unmounts, state resets, and the operation silently dies.

The fix: move the entire flow to the server as a fire-and-forget background job.
The client posts one request and gets out of the way; the server does everything
regardless of what the user does in the UI.

---

## Design

### Server: new `push-and-exit` server plugin

**Files to create:**

```
plugins/conversations/plugins/conversation-view/plugins/push-and-exit/
└── server/
    └── index.ts           # ServerPluginDefinition + background job logic
    └── internal/
        └── prompt.ts      # PUSH_AND_EXIT_PROMPT, CLEAN_TOKEN, FLAG_TOKEN (server-only)
```

**In-memory job map** (no DB — transient operation state, resets with server):

```typescript
type JobState =
  | { status: "running" }
  | { status: "clean" }
  | { status: "flag"; text: string }
  | { status: "error"; message: string };

const jobs = new Map<string, JobState>();
```

**Resource** (push mode — small payload, same for all subscribers):

```typescript
export const pushAndExitResource = defineResource({
  key: "push-and-exit",
  mode: "push",
  loader: async () => Object.fromEntries(jobs),
});
```

**Endpoints:**

- `POST /api/conversations/:id/push-and-exit` — start job (202) or return 409 if running
- `DELETE /api/conversations/:id/push-and-exit` — clear acknowledged job entry

**Background job `runJob(id)`:**

1. Record `triggeredAt = new Date().toISOString()`
2. Look up `runtime` id from DB (via exported `getConversationStatus`)
3. `Runtime.get(runtime).send(id, PUSH_AND_EXIT_PROMPT)`
4. Poll DB until `status === "working"` (2s interval, 60s timeout)
5. Poll DB until `status !== "working"` (2s interval, 10min timeout)
6. Read transcript via `readConversationTurns(id, triggeredAt)` — new `api.ts` export
7. Find last assistant `end_turn` message, run `interpret()` to get verdict
8. Update `jobs.set(id, verdict)` + `pushAndExitResource.notify()`
9. If `clean`: call `deleteConversation(id)` + `conversationsResource.notify()` — new `api.ts` export

Errors are caught, stored as `{ status: "error", message }`, and notified.

---

### Conversations `api.ts` additions

Three new exports (all delegate to existing `internal/` code):

```typescript
// plugins/conversations/server/api.ts

// For closing the conversation from the job
export { deleteConversation } from "./internal/lifecycle";

// For status polling
export async function getConversationRow(id: string): Promise<{
  status: string; runtime: string; claudeSessionId: string | null;
} | null>

// For transcript reading after the turn completes
export async function readConversationTurns(id: string, since?: string): Promise<Turn[]>
export type { Turn } from "./internal/claude-transcript";
```

`readConversationTurns` wraps the DB lookup for `claudeSessionId` + `findTranscriptPath` + `readTurns` so the sibling plugin doesn't need to touch `internal/`.

---

### Prompt constants

`web/prompt.ts` is deleted — the frontend no longer sends the prompt or interprets
tokens. Constants move to `server/internal/prompt.ts` (server-only).

---

### Client: simplified `PushAndExitButton`

Drop the entire state machine. The component becomes:

```typescript
const jobs = useResource("push-and-exit") as Record<string, JobState> | undefined;
const job = jobs?.[conversation.id];

// When clean arrives while mounted: toast + navigate + clear
useEffect(() => {
  if (job?.status !== "clean") return;
  Shell.Toast({ description: "Pushed and closed", variant: "success" });
  fetch(`/api/conversations/${conversation.id}/push-and-exit`, { method: "DELETE" }).catch(() => {});
  navigateHome();
}, [job?.status]);

// Button click: one POST, done
async function onClick() {
  await fetch(`/api/conversations/${conversation.id}/push-and-exit`, { method: "POST" });
}
```

- `busy` = `job?.status === "running"`
- Flag sheet: shown when `job?.status === "flag"`, text from `job.text`
- On "Keep open": `DELETE /push-and-exit` (just clears UI state; conversation stays open)
- On "Close": `POST /close` then `DELETE /push-and-exit`
- If `clean` arrives while user is elsewhere: conversation is already gone; no action needed on return

The revert of the module-level `sessionStateByConversation` map added in the previous fix is included in this change.

---

## Files to modify

| File | Change |
|------|--------|
| `plugins/conversations/server/api.ts` | Add `deleteConversation`, `getConversationRow`, `readConversationTurns`, `Turn` exports |
| `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/prompt.ts` | Delete |
| `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/prompt.ts` | Create (server-only constants) |
| `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/index.ts` | Create (new server plugin) |
| `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/push-and-exit-button.tsx` | Simplify: drop state machine, use resource |
| `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/index.ts` | Update prompt import path |
| `server/src/plugins.ts` | Import + register `pushAndExitPlugin` after `conversationsPlugin` |
| `docs/plugins.md` | Add server section to `push-and-exit` entry |

---

## Verification

1. `./equin build` — no TypeScript errors
2. Open a conversation → click Push & Exit → navigate to `/tasks` immediately
3. Check that "Pushing…" state shows on the button when you navigate back (resource update)
4. Verify the push completes and conversation closes even though you were on `/tasks`
5. For the flag path: confirm the sheet appears when you return to the conversation after the agent flags something
