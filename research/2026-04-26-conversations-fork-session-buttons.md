# Fork-session buttons in the conversation view

## Context

The conversation prompt bar already has +Sonnet/+Opus buttons (the
`fork-conversation` plugin) that spawn a brand-new, fresh Claude conversation
in the *same worktree* — useful for parallel work but starting from zero
context.

We want a second pair of +Sonnet/+Opus buttons that **fork the current
conversation's history** via `claude --resume <session-id> --fork-session`,
so different branches of the same agent thread can be explored without
losing the parent's context. As today, when the user has typed text into
the prompt input, that text should become the first message sent to the
forked conversation.

The conversation row already carries a `claudeSessionId` column (populated
by the tmux poller once Claude has written its sessions file), so the
fork has everything it needs server-side — we just need to plumb a new
option end-to-end and add a sibling plugin to host the buttons.

## Design decisions (confirmed with user)

- **Section labels:** rename the existing section from `Fork` → `New`
  (those buttons create *fresh* conversations) and use `Fork` for the new
  section (they actually fork the history).
- **Pre-session state:** when `claudeSessionId` is `null` (conversation
  still starting, before Claude has written its sessions file), the new
  buttons render *disabled* with a tooltip "Waiting for Claude session…".
  Server-side validation rejects the call too.

## Plan

### 1. Backend — extend the runtime + lifecycle to support fork-session

#### `plugins/conversations/server/internal/runtime.ts`

Extend the `ConversationRuntime.create` opts type with `forkSession?: boolean`.

#### `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`

The existing `claudeCmd` builder is mutually-exclusive between `resume`
and `prompt`. Rewrite it to allow all three combinations:

```ts
const parts: string[] = [claudeBase];
if (opts?.resumeSessionId) {
  parts.push(`--resume ${opts.resumeSessionId}`);
  if (opts.forkSession) parts.push("--fork-session");
}
if (hasPrompt) parts.push(`"$SINGULARITY_PROMPT"`);
const claudeCmd = parts.join(" ");
```

Existing `resumeConversation` (gone-conversation restore) never sets
`prompt`, so this is a strict superset of today's behaviour.

#### `plugins/conversations/server/internal/lifecycle.ts`

Add `forkFromConversationId?: string` to `createConversation` opts.
When set:
- Look up source conversation via `getConversation()`.
- If the source has no `claudeSessionId`, throw a clear error
  ("Source conversation hasn't started yet — Claude session id not
  available").
- Force `attemptId` to the source's attempt (reuse same worktree). If
  caller passed a conflicting attemptId, throw.
- Default `model` to source's model when caller didn't pass one (so
  +Sonnet/+Opus still let the user pick the fork model).
- Pass `resumeSessionId: source.claudeSessionId, forkSession: true` to
  `runtime.create`, alongside the user's optional `prompt`.

#### `plugins/conversations/server/internal/handle-create.ts`

Pass through `forkFromConversationId` from the JSON body.

### 2. Frontend — extend `LaunchRequest` and rename existing section

#### `plugins/launch/web/components/launch-buttons.tsx`

Add `forkFromConversationId?: string` to the `LaunchRequest` type, and
include it in the `POST /api/conversations` body when present.

#### `plugins/conversations/plugins/conversation-view/plugins/fork-conversation/web/index.ts`

Change `section: "Fork"` → `section: "New"`. Tooltip in
`fork-conversation-buttons.tsx` already says "New conversation in this
worktree", so the rename matches what users see.

### 3. Frontend — new `fork-session` plugin

Create a sibling under
`plugins/conversations/plugins/conversation-view/plugins/fork-session/`:

- `package.json` — copy of fork-conversation's, name
  `@singularity/plugin-fork-session`.
- `web/index.ts` — barrel: imports the component, default-exports a
  `PluginDefinition` with id `conversation-fork-session`, contributing to
  `Conversation.PromptBar({ section: "Fork", sectionOrder: 2 })`.
- `web/components/fork-session-buttons.tsx` — modeled on
  `fork-conversation-buttons.tsx`:
  - Uses `GitBranchPlus` from `lucide-react` for visual differentiation.
  - Reads `usePromptDraft(conversation.id)`.
  - Disabled when `!conversation.claudeSessionId`.
  - Passes `LaunchRequest` with `forkFromConversationId: conversation.id`
    and the trimmed prompt (if any). Uses `clearDraft` `onLaunched`.
  - Tooltip: "Waiting for Claude session…" when disabled, otherwise
    "Fork conversation" / "Fork conversation — sends typed message"
    depending on draft state.

### 4. Register and rebuild

- `web/src/plugins.ts`: import `conversationForkSessionPlugin` and append
  to the registry array.
- Run `./equin build` from this worktree — the build runs the
  `plugins-doc-in-sync` check and regenerates `docs/plugins.md`
  automatically; commit whatever diff it produces.

## Files to modify (summary)

```
plugins/conversations/server/internal/runtime.ts
plugins/conversations/server/internal/lifecycle.ts
plugins/conversations/server/internal/handle-create.ts
plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts
plugins/launch/web/components/launch-buttons.tsx
plugins/conversations/plugins/conversation-view/plugins/fork-conversation/web/index.ts
web/src/plugins.ts
```

## Files to create

```
plugins/conversations/plugins/conversation-view/plugins/fork-session/package.json
plugins/conversations/plugins/conversation-view/plugins/fork-session/web/index.ts
plugins/conversations/plugins/conversation-view/plugins/fork-session/web/components/fork-session-buttons.tsx
```

## Verification

1. `./equin build` — must succeed (plugin-boundaries +
   plugins-doc-in-sync checks pass).
2. Open `http://att-1777201710-9x8m.localhost:9000`, create a
   conversation, wait for Claude to land.
3. Confirm prompt bar shows two sections: **New** (existing buttons)
   and **Fork** (new buttons).
4. Before claudeSessionId is populated, the **Fork** buttons render
   disabled with the "Waiting for Claude session…" tooltip.
5. Click `+Opus` under **Fork** with no prompt typed → a new
   conversation appears in the same worktree, opens in pane, and the
   tmux pane shows
   `claude --model opus --resume <id> --fork-session` in its history.
6. In a separate fork, type a draft message into the prompt input,
   click `+Sonnet` under **Fork** → new conversation runs
   `claude --model sonnet --resume <id> --fork-session "<draft>"` and
   Claude treats the draft as its first user turn. Draft should clear
   in the parent conversation after launch.
7. Existing **New** buttons (`fork-conversation` plugin) still work
   unchanged — confirm one launches with no resume flag and just a
   fresh `claude` command.
