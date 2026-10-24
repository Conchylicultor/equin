# Pending content indicator in JSONL viewer

## Context

When Claude CLI is mid-turn and waiting for interactive user input (e.g. AskUserQuestion), the assistant response events are **not** flushed to the JSONL file until the user responds. The terminal shows the content live, but the JSONL viewer is stuck on the last flushed events. The user has no way to know there's more content in the terminal.

The Claude session file (`~/.claude/sessions/<pid>.json`) has a `waitingFor` field (e.g. `"approve AskUserQuestion"`) that reliably indicates buffered content exists.

## Design

Two changes in one:

1. **Unify status source.** Today, conversation `status` is inferred from the tmux pane title (spinner glyph heuristic). The session file already has an authoritative `status` field — switch to reading it from there instead.
2. **Surface `waitingFor`.** Read `waitingFor` from the same session file and propagate it to the frontend to show a pending-content indicator.

Both fields come from one file read per tick, replacing the pane-title heuristic with the CLI's own state.

### Session file status values

The session file (`~/.claude/sessions/<pid>.json`) uses these status values (observed from CLI v2.1.132):

| Session `status` | Meaning | Maps to Singularity | `waitingFor` |
|---|---|---|---|
| `busy` | Claude is computing | `working` | never set |
| `idle` | Turn done, prompt shown | `waiting` | never set |
| `waiting` | Mid-turn, needs user action | `waiting` | set (e.g. `"approve AskUserQuestion"`) |
| (missing/null) | Session file not yet written | fall through to `null` | — |

These are undocumented Claude CLI internals. The mapping is **exhaustive with a hard error on unknown values** — if the CLI adds a new status, the poller throws so we notice immediately rather than silently misclassifying.

### 1. Replace `readSessionId` with `readSessionState` in `claude-session.ts`

**File:** `plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`

The existing `readSessionId(pid)` reads the session JSON and extracts only `sessionId`. Replace it with a broader reader:

```ts
type CliSessionStatus = "busy" | "idle" | "waiting";

interface SessionState {
  sessionId: string | null;
  status: CliSessionStatus | null;
  waitingFor: string | null;
}

async function readSessionState(pid: number): Promise<SessionState> {
  try {
    const raw = await readFile(`${SESSIONS_DIR}/${pid}.json`, "utf8");
    const parsed = JSON.parse(raw);
    const rawStatus = parsed.status;
    let status: CliSessionStatus | null = null;
    if (typeof rawStatus === "string") {
      if (rawStatus === "busy" || rawStatus === "idle" || rawStatus === "waiting") {
        status = rawStatus;
      } else {
        throw new Error(
          `Unknown Claude CLI session status "${rawStatus}" in ${SESSIONS_DIR}/${pid}.json — update the status map`,
        );
      }
    }
    return {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
      status,
      waitingFor: typeof parsed.waitingFor === "string" ? parsed.waitingFor : null,
    };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Unknown Claude CLI")) throw err;
    return { sessionId: null, status: null, waitingFor: null };
  }
}
```

Add a new export that resolves the full state for a tmux pane (same child-walking as `resolveClaudeSessionId`):

```ts
export async function resolveSessionState(panePid: number): Promise<SessionState> {
  let state = await readSessionState(panePid);
  if (state.sessionId == null) {
    for (const child of await pgrepChildren(panePid)) {
      state = await readSessionState(child);
      if (state.sessionId) break;
    }
  }
  if (state.sessionId) pidCache.set(panePid, state.sessionId);
  return state;
}
```

The existing `resolveClaudeSessionId` stays as a thin wrapper (other callers use it). Remove the `readSessionId` helper — `readSessionState` subsumes it.

Export `resolveSessionState` from `runtime-tmux/server/index.ts`.

### 2. Extend `RuntimeInfo`, clean up `tmux-runtime.ts`

**File:** `plugins/conversations/server/internal/runtime.ts`

```ts
export interface RuntimeInfo {
  title: string;
  working: boolean;
  dead: boolean;
  claudeSessionId: string | null;
  worktreePath: string;
  waitingFor: string | null;   // NEW
}
```

**File:** `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`

In `list()`, replace `resolveClaudeSessionId` with `resolveSessionState`. Derive `working` from the session file status:

```ts
const states = await Promise.all(
  ids.map((id) => resolveSessionState(panes.get(id)!.panePid)),
);

ids.forEach((id, i) => {
  const { rawTitle, dead, worktreePath } = panes.get(id)!;
  const { title } = cleanPaneTitle(rawTitle ?? "");
  const state = states[i]!;
  // Session file is authoritative for status.
  // null = file not written yet (startup race) — treat as working
  // (the conversation was just created, Claude is booting).
  const working = state.status == null || state.status === "busy";
  out.set(id, {
    title,
    working: working && !dead,
    dead,
    claudeSessionId: state.sessionId ?? null,
    worktreePath,
    waitingFor: dead ? null : state.waitingFor,
  });
});
```

Remove `SPINNER_RE`, `READY_RE` constants. Simplify `cleanPaneTitle` to only strip prefixes for title extraction — it no longer returns `working`.

### 3. Add `waitingFor` DB column

**File:** `plugins/tasks-core/server/internal/tables.ts`

```ts
waitingFor: text("waiting_for"),   // nullable, e.g. "approve AskUserQuestion"
```

Auto-propagates to `Conversation` type via `createSelectSchema`.

**File:** `plugins/tasks-core/server/internal/mutations/conversations.ts`

Add `waitingFor?: string | null` to `UpdateConversationPatch`. Add to the `dbPatch` assembly (same pattern as `claudeSessionId`/`endedAt`).

### 4. Poller writes `waitingFor`

**File:** `plugins/conversations/server/internal/poller.ts`

```ts
const desiredWaitingFor = desiredStatus === "waiting" ? info.waitingFor : null;
const waitingForChanged = (desiredWaitingFor ?? null) !== (dbRow.waitingFor ?? null);

// Add to the "nothing changed" guard
if (!titleChanged && !sessionChanged && !statusChanged && !waitingForChanged) continue;

// Add to patch
if (waitingForChanged) patch.waitingFor = desiredWaitingFor;
```

Clear `waitingFor` in both gone paths (dead pane + sweep):
```ts
await updateConversation(id, { status: "gone", endedAt: new Date(), waitingFor: null });
```

### 5. Frontend indicator

**File:** `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx`

Add `PendingContentIndicator` component — subtle amber text below the events list:

```tsx
function PendingContentIndicator() {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <span className="text-xs text-amber-500/70">
        Content pending in terminal — waiting for your input
      </span>
    </div>
  );
}
```

Render after `WorkingIndicator`, guarded by `!isWorking && !!conversation.waitingFor`:

```tsx
{isWorking && <WorkingIndicator startAt={workingStartAt} />}
{!isWorking && !!conversation.waitingFor && <PendingContentIndicator />}
```

## Files to modify

1. `plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts` — `readSessionState` + `resolveSessionState`, remove `readSessionId`
2. `plugins/conversations/plugins/runtime-tmux/server/index.ts` — export `resolveSessionState`
3. `plugins/conversations/server/internal/runtime.ts` — add `waitingFor` to `RuntimeInfo`
4. `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts` — use `resolveSessionState`, derive `working` from session status, remove spinner heuristic
5. `plugins/tasks-core/server/internal/tables.ts` — add `waiting_for` column
6. `plugins/tasks-core/server/internal/mutations/conversations.ts` — add to `UpdateConversationPatch`
7. `plugins/conversations/server/internal/poller.ts` — write `waitingFor` to DB
8. `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx` — indicator component

## Verification

1. `./equin build` — generates migration, deploys
2. Open a conversation where Claude is waiting for AskUserQuestion
3. Verify the JSONL viewer shows "Content pending in terminal" at the bottom
4. Answer the question in the terminal
5. Verify the indicator disappears and new events appear
6. Verify no indicator on `working` or `gone` conversations
7. Kill a Claude process mid-AskUserQuestion → verify `waitingFor` clears when marked gone
8. Start a new conversation → verify status works before session file exists (treated as working)
