# Optimistic first turn — type and send while the agent is still starting

## Context

After the spare-worktree pool (`research/2026-10-07-infra-spare-worktree-pool.md`), a launch still
takes ~8–12 s before the user can talk to the agent: `conversations.spawn` takes 1.6–3.4 s, and
then Claude Code takes 5–9 s at the current host load to draw its input box. The prompt box is
**disabled** for that whole window (`prompt-input.tsx`: `disabled = … || starting || …`, with the
placeholder "Starting…").

Most of that wait does not need to be visible. The user already knows what they want to say, so let
them say it right away:

- The message shows at once as sent.
- The agent gets it the moment it can take it.
- If it arrives before the pane exists, it becomes Claude's launch message, so Claude starts on it
  directly without ever idling at an empty prompt.

What exists today:

- The client side is mostly built. `pending-turn` (`sendConversationTurn`) already keeps a durable
  record, draws the dimmed echo card, and treats the transcript as ground truth. `jsonl-pane.tsx`
  already shows the pending card instead of the starting indicator when a `starting` conversation
  has pending turns.
- The server does not hold the turn. `handlePostTurn` → `sendTurn` → tmux `send` types immediately.
  With no pane yet, `send-keys` fails (500, turn lost). With a pane but no input box yet, the
  keystrokes land in the booting TUI and the 5 s verification times out.

## Design

### Server: held turns, delivered by exactly one of two paths

**Table `conversation_held_turns`** (conversations plugin):
- Columns: `id`, `conversation_id` (FK → conversations, `ON DELETE CASCADE`), `text` (attachment
  refs already resolved), `raw_text`, `created_at`.
- A row exists only while the turn is undelivered.

**Accept (`handlePostTurn`, `plugins/conversations/server/internal/handle-post-turn.ts`)**: one
transaction does the following.
1. Resolve attachments (unchanged), then `SELECT … FOR UPDATE` the conversation row.
2. If its status is `starting`, insert a held turn, commit, and return
   `{ resolvedText, held: true }`. `userTurnSent` is not emitted yet.
3. Otherwise, take today's path unchanged and return `held: false`.

The row lock is what makes the two delivery paths below race-free. The status flip out of
`starting` is an UPDATE of the same row, so it serializes behind the accept: a turn is either held
before the flip, and seen by the flush that follows it, or sent directly after it.

**Path A, the launch message (`spawn-job.ts`, just before `runtime.create`)**:
1. Read the held turns, oldest first.
2. Append them to `create.prompt`. The baked preprompt block (`lifecycle.ts` `prepareConversation`)
   stays first, so a held first message carries the task's preprompt exactly as a launch prompt
   does today.
3. Run `runtime.create`, then delete exactly those held-turn ids and emit `userTurnSent` for each.

Retry is safe: `runtime.create` no-ops once the pane exists, and the delete is by id. A turn
accepted after step 1 stays held and goes to path B.

**Path B, the flush when the agent becomes ready**:
- Trigger: the status reconciler (`status-reconciler.ts`), whenever it moves a row out of
  `starting`, enqueues `conversations.deliver-held-turns` (`dedup` by conversation id, enqueued
  after the status write). A push trigger, not a poll.
- The job:
  1. `waitForInputReady(conversationId)` in `tmux-runtime.ts`: until the `❯` input box parses
     (`captureInputDraft(...) !== null`), bounded at 60 s.
  2. For each held turn in order: `sendTurn` (the existing typed-and-verified path), delete the
     row, emit `userTurnSent`.
- Why step 1 polls: the CLI emits no "input box drawn" event, and `starting → waiting` (the
  sessions-file write) is close to it but not a guarantee. This is the same bounded, rendered-box
  check `typeTurn` already uses. It is documented as that file's one sanctioned wait, not a loop.
- A 60 s timeout files a `held-turn-undelivered` report and leaves the row held, so the next flip
  or a Resume can still deliver it.

**Resume / gone**: `respawnResume` also enqueues the flush, so a held turn on a conversation that
failed to start is delivered when the user resumes it. Deleting the conversation cascades its held
turns.

### Web: let the box send while starting

- **`prompt-input.tsx`**: drop `starting` from `disabled`. That also opens `send`, `sendText` and
  `canSend` for quote/quick answers. Set the placeholder to "Agent starting — send now, it gets your
  message when ready". The prompt-template chips' `starting` gate is lifted the same way. The
  exit/hold/drop gates stay.
- **`pending-turn`**:
  - The turn endpoint's response gains `held: boolean`. A `held` response moves the record to a new
    `held` state (between `posted` and `sent`).
  - `PendingTurnCard` renders it like `posted`, subtitled "Waiting for the agent to start…".
  - The 90 s confirmation deadline is unchanged; boot plus delivery fits in it. A turn that misses
    it still goes `unconfirmed` with Retry, and a late transcript match still retires the card
    (never-revert).
- **Text matching**: the reconcile matches by normalized text. A turn delivered as the launch
  message lands in the transcript prefixed by the preprompt block when the task has one. The
  matcher must accept a user row that ends with the record's text. That is one rule in
  `reconcile.ts`, covered by a test.

## Critical files

- `plugins/conversations/server/internal/`:
  - `handle-post-turn.ts`: lock, hold or send.
  - `held-turns.ts` (new): table, read, delete, append.
  - `spawn-job.ts`: path A.
  - `status-reconciler.ts`: enqueue the flush on leaving `starting`.
  - `deliver-held-turns-job.ts` (new): path B.
  - `lifecycle.ts`: `respawnResume` enqueues the flush.
- `plugins/conversations/core/endpoints.ts`: `postConversationTurn` response gets `held`.
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`: `waitForInputReady`
  next to `captureInputDraft`. If the conversations server needs it, expose it on
  `ConversationRuntime` as `waitUntilReady(id, signal)`; the tmux runtime implements it.
- `plugins/conversations/plugins/conversation-view/plugins/prompt-input/web/components/prompt-input.tsx`
  and `…/prompt-templates/web/components/prompt-template-chips.tsx`: the gate.
- `plugins/conversations/plugins/conversation-view/plugins/pending-turn/web/internal/`:
  - `store.ts` / `delivery.ts`: the `held` state.
  - `reconcile.ts`: the suffix match.
  - `PendingTurnCard`: the subtitle.
  - The plugin's `CLAUDE.md`: state machine update.

Reused pieces: `sendTurn` and `typeTurn` (verified typing), `captureInputDraft`, `defineJob` with
`dedup`, the `pending-turn` record and card, `resolveAttachmentRefs`, and the existing
`userTurnSent` emit.

## Verification

- **Tests** (`./equin test plugins/conversations`):
  - Held-turn store on the DB test fixture: accept while `starting` holds; accept after the flip
    sends directly; concurrent accept and flip never strand a row (flip, then flush sees it).
  - Spawn path A merges preprompt + held turns in order and deletes only the claimed ids.
  - Reconcile suffix-match.
- **Live**, after `./equin build`, on the worktree deploy:
  - Launch from the sidebar and type and send within ~1 s. Expect an echo card "Waiting for the
    agent to start…", then Claude starts working on it with no idle prompt in between (path A).
  - Launch, wait ~3 s (pane up, CLI booting), send. Expect the echo, then delivery right after the
    input box appears (path B; check the `conversations.deliver-held-turns` run in
    `job_recent_runs`).
  - Both: the card retires on the transcript match, and no `turn-unconfirmed` report is filed.
