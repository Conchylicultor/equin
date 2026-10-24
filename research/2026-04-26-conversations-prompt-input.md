# Conversation prompt input + fork-with-prompt

## Context

The conversation view has a bottom action bar (`Conversation.PromptBar` slot) populated
by buttons like Push & Exit, Quick Prompts, Fork (+Sonnet/+Opus), Resume, etc. There is
no way to type a free-form message from the UI — turns can only be sent via tmux, quick
prompts, or via the underlying CLI session itself.

We want:

1. A free-form text input field at the bottom of the conversation view that sends the
   typed text as a turn to the active conversation (`POST /api/conversations/:id/turn`).
2. When the user clicks the +Sonnet / +Opus fork buttons while text is in the input,
   the new conversation is created with that text as its initial prompt instead of
   being launched empty. Fork while empty keeps today's behavior.

The text typed in the input is shared state between two PromptBar contributors (the
new prompt-input plugin and the existing fork-conversation plugin). They live in
sibling sub-plugins, so we need a small shared-state primitive in the parent
`conversation-view` plugin.

## Approach

- **Lift the draft into a React context** owned by `conversation-view`. Two
  contributors (the new prompt-input and the existing fork-conversation) read/write it.
  Drafts are keyed by `conversationId`, so switching conversations preserves each one's
  in-flight draft (lost on full page refresh — fine, no persistence needed).
- **Add the input as its own sub-plugin** (`prompt-input/`) under `conversation-view`,
  consistent with how every other prompt-bar action is already its own plugin.
- **Restructure the bottom bar** so the input grows (`flex-1`) on the left and the
  existing button sections sit on the right. Single row, no extra vertical space.
- **Reuse `LaunchButtons`'s existing `prompt` field** — it already forwards `prompt`
  to `POST /api/conversations`, which already passes it as the initial message. The
  only addition needed in `LaunchButtons` is an `onLaunched` callback so fork can
  clear the draft on success.

## Files to modify / create

### New: draft context

**`plugins/conversations/plugins/conversation-view/web/prompt-draft-context.tsx`** *(new)*

- Exports `<PromptDraftProvider>` (holds `Map<convId, string>` in state).
- Exports `usePromptDraft(convId)` returning `{ draft, setDraft, clearDraft }`.
- Mounted by `ConversationView` so all PromptBar contributions can read/write.

### Modify: slot definitions

**`plugins/conversations/plugins/conversation-view/web/slots.ts`**

- Add a singular slot `Conversation.PromptInput` (one `component` prop, expects
  exactly one contribution — first wins, like `Conversation.Title`).

### Modify: conversation view layout

**`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`** (lines 18–54, 103–112)

- Wrap the body with `<PromptDraftProvider>` (around or inside the existing
  `conversationPane.Provider`).
- Pull the bottom bar's container styling (`border-t`, padding, gap) up one level
  into a wrapper that holds:
  - `<PromptInputComponent conversation={conversation} />` wrapped in `flex-1 min-w-0`
    (only when a contribution exists).
  - The existing `<PromptBar items=… />` section list (strip the outer container
    styling from `PromptBar` itself; it just renders the section groups now).
- Show the wrapper if either the input slot or any PromptBar item exists.

### Modify: launch buttons

**`plugins/launch/web/components/launch-buttons.tsx`** (lines 17–24, 40–59)

- Add `onLaunched?: (conversation: Conversation) => void` to `LaunchButtonsProps`.
- After `conversationPane.open(...)` succeeds, call `onLaunched?.(conversation)`.

### New: prompt-input sub-plugin

**`plugins/conversations/plugins/conversation-view/plugins/prompt-input/`** *(new)*

- `web/index.ts` — registers `Conversation.PromptInput({ component: PromptInput })`.
- `web/components/prompt-input.tsx`:
  - Auto-resizing `<Textarea>` (shadcn) bound to `usePromptDraft(conversation.id)`.
  - Enter submits, Shift+Enter inserts a newline.
  - Submit `POST /api/conversations/:id/turn` with `{ text }` — same pattern as
    `quick-prompts/web/components/quick-prompt-chips.tsx:26-43`.
  - `clearDraft()` on 2xx; `Shell.Toast({ variant: "error" })` on failure.
  - Disabled while `live.status === "gone" || "starting"` (mirrors quick-prompts).
- `package.json` + register in the parent plugin registry the same way other
  conversation-view sub-plugins are registered.

### Modify: fork-conversation

**`plugins/conversations/plugins/conversation-view/plugins/fork-conversation/web/components/fork-conversation-buttons.tsx`** (lines 10–28)

- Call `const { draft, clearDraft } = usePromptDraft(conversation.id)`.
- Change `getRequest` to return
  `{ attemptId: conversation.attemptId, prompt: draft.trim() || undefined }`.
- Pass `onLaunched={clearDraft}` to `<LaunchButtons />`.

### Docs

**`docs/plugins.md`**

Regenerated automatically by the `plugins-doc-in-sync` check during
`./equin build` — a new `prompt-input` entry will appear under
`conversation-view`'s sub-plugins, and the `Conversation.PromptInput` slot will be
listed under `conversation-view`'s `Defines: Slots`.

## Reused primitives

- `POST /api/conversations/:id/turn` — server-side handler at
  `plugins/conversations/server/internal/handle-post-turn.ts:1-24`, reachable via the
  fetch pattern used by `quick-prompts`.
- `LaunchRequest.prompt` — already plumbed end-to-end into
  `plugins/conversations/server/internal/handle-create.ts`.
- `useConversation(convId)` for live status (`gone`/`starting`/etc.).
- `ShellCommands.Toast` for error feedback.
- shadcn `<Textarea>` from `@/components/ui/textarea`.

## Open behavior choices (defaults chosen — call out if you'd prefer otherwise)

- **Layout**: single row at the bottom, input on the left growing to fill, buttons on
  the right. (Alternative: input as a row above the existing button row.)
- **Submit**: Enter sends, Shift+Enter inserts newline. (Alternative: explicit Send
  button.)
- **Draft scope**: per-conversation, in-memory only (lost on refresh). (Alternative:
  localStorage persistence.)

## Verification

1. `./equin build` → confirm the build succeeds and `plugins-doc-in-sync`
   passes (the new plugin and slot appear in `docs/plugins.md`).
2. Open a conversation in the worktree app at `http://<worktree>.localhost:9000`.
3. **Send turn** — type a message, press Enter; verify it lands in the tmux session
   (visible in the conversation terminal) and the input clears.
4. **Multiline** — Shift+Enter inserts a newline without submitting.
5. **Fork with prompt** — type a message, click `+Sonnet`; verify a new conversation
   opens, the typed text is its first turn (visible in its terminal), and the input
   in the original conversation is cleared.
6. **Fork while empty** — clear input, click `+Opus`; verify a new conversation opens
   empty, matching today's behavior.
7. **Disabled state** — observe the input is disabled while a conversation is in
   `starting` or `gone` status.
8. **Per-conversation drafts** — type into A, switch to B without sending, switch
   back to A; A's draft is still there.
9. **Error handling** — temporarily break the endpoint (e.g. send to a `gone`
   conversation); a toast surfaces the error and the draft is preserved.
