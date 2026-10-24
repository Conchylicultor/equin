# Rewind a conversation

## Context

You want to go back to an earlier message in a conversation and continue from
there, dropping everything after it. The native CLI does this with `/rewind`,
but Singularity wraps the interactive CLI in a tmux pane, so the only way to
reach that command is to send keystrokes through a menu — fragile.

This plan takes a different route, validated by experiment on CLI 2.1.276:
**stop the process, cut the transcript file, and start a plain
`claude --resume` on it.** The CLI only ever sees an ordinary resume.

Two things the user gets, both as a row action on any of their own messages in
the transcript view:

- **Rewind to here** — the same conversation continues from just before that
  message. The message text lands back in the prompt editor as a draft.
- **Fork from here** — a new conversation on the same worktree starts from just
  before that message. The original conversation is untouched.

### What the experiments established

| Question | Result |
|---|---|
| Does a hand-truncated transcript resume interactively? | Yes. The model only knew the kept turns. |
| Prompt cache after the cut | Full hit (22,784 tokens read, 0 written). |
| CLI's hidden `--resume-session-at <message id>` | Print mode only; ignored by an interactive pane. Not usable. |
| Native `/rewind` past an agent's report | The report is lost for good; the model keeps "waiting" forever. |
| Native `/rewind` while an agent still runs | The report lands in the rewound branch (the agent lives in the process). |
| Restart on a transcript that launched an agent with no result | The CLI prints that the agent "didn't finish before the previous session ended", then **runs one model turn with no user input** saying it failed. |
| Subagents / background shells across a restart | Killed with the pane. Never restored. |

So a restart-based rewind cannot keep background work alive, and a report that
falls after the cut is lost in every approach, native included. The design
makes that loss **visible before the user confirms**, rather than pretending to
preserve it.

## Decisions

1. **Rewind to here truncates the live transcript file in place** (same
   session id), after backing it up. It does not write a copy under a new id.
   - The Stop button already does exactly this for the last unanswered prompt
     (`rewindLastUserTurn`, `plugins/conversations/server/internal/claude-transcript.ts`).
   - Same session id means nothing else moves: the session chain, the poller's
     session adoption, the CLI's subagent folder and file checkpoints
     (`~/.claude/file-history/<session>/`), and the cost index all keep working.
   - Verified safe: no consumer stores byte offsets or cursors into the
     transcript. The chain signature is `(path, mtime, size)`, the usage index
     replaces a file's whole partial on change, and row keys are content-based.
   - Rejected alternative: a copy under a new session id. The viewer merges
     every file in the conversation's chain, so the discarded tail would keep
     showing until new lines arrived. Fixing that needs a "supersedes" marker
     in the chain plus a special case in the merge — more machinery, and copied
     lines inflate the cost stats.
2. **Fork from here writes a truncated copy** under a fresh session id in the
   same `~/.claude/projects/<slug>/` folder, then plain-resumes it
   (`forkSession: false`). A new conversation's chain is just that one file, so
   the merge problem does not exist here. Same folder keeps the foreign-session
   and session-divergence monitors quiet.
3. **One cut function serves Stop, Rewind and Fork**, and it also produces the
   list of what the cut loses. Preview and execution call the same function, so
   the dialog can never disagree with what actually happens.
4. **If the chosen message is not in the newest session file** (only possible
   after an earlier fork), Rewind refuses with a typed reason and the UI offers
   Fork instead. Chains are length 1 in ordinary use, so this is rare.
5. **Files in the worktree are not restored in v1.** The dialog says so. See
   Follow-ups.

## Design

### 1. The cut primitive (server, pure)

`plugins/conversations/server/internal/claude-transcript.ts`, next to
`rewindLastUserTurn`:

```ts
cutTranscriptAt(rawLines: string[], userMessageUuid: string): CutResult

type CutResult =
  | { ok: true; keepCount: number; messageText: string; losses: CutLosses }
  | { ok: false; reason: "not-found" | "not-a-live-user-prompt" };

interface CutLosses {
  laterUserTurns: number;
  lostReports: { description: string }[];   // launched before the cut, reported after it
  killedRunning: { description: string }[]; // launched, no report anywhere yet
}
```

- A valid target is a line on the live path (`activeLineUuids`,
  `transcript-watcher/core/branch-filter.ts`), `type: "user"`, string content,
  not an interrupt sentinel — the same predicate `rewindLastUserTurn` uses.
- `keepCount` is that line's index, **walked back over any uuid-less
  `queue-operation` lines directly before it** that belong to the same prompt.
  Otherwise a dangling "Sent to agent" row survives the cut.
- Losses come from the raw lines: `Agent` / background task `tool_use` blocks
  before the cut, matched to their `tool_result` / task-notification /
  hand-back lines by id. Report after the cut → `lostReports`. No report at
  all → `killedRunning`.
- `rewindLastUserTurn` becomes a thin caller: find the last unanswered user
  prompt (its existing backward scan and guards), then cut there. One
  truncation code path.

### 2. Rewind to here (server)

New `rewindConversationAt(id, uuid)` in
`plugins/conversations/server/internal/lifecycle.ts`, ordered so that **a
refusal leaves the conversation untouched** (same discipline as
`preflightResume`):

1. Read-only: load the row, run `preflightResume`, resolve
   `resolveConversationTranscriptPaths(id)`, run `cutTranscriptAt` on the tail
   file. Refuse with a typed reason on: no session, worktree missing, cut
   failed, or `not-in-tail` (the uuid exists only in an older chain file).
2. (The pane is killed by `respawnResume` in step 4. This is the first time the
   resume path is used on a *live* pane, so a running turn is stopped
   mid-flight — the dialog warns about it.)
3. Clear `closeRequested`, move the tail file to the backup path, write the
   kept lines in its place.
4. `respawnResume(row)` unchanged (it kills the pane) (same session id), then clear
   `hibernatedAt` and `closeRequested` — the user is continuing, not closing.
5. Return `{ rewindText: messageText }`.

**Backup, bounded.** The rewind *moves* the live session file into a
`state`-kind data dir (`conversation-rewinds/<conversationId>.<epochMs>.jsonl`)
and writes the shortened transcript in its place. A move, not a copy: the CLI
being killed still holds the old file open, so anything it appends on its way
down follows the moved file instead of landing after the cut. A nightly
main-only `defineJob` deletes backups older than 30 days by mtime.

> Changed during implementation. The first draft had a `conversation_rewinds`
> table with `defineRetention`. Dropped: the folder is host-global while the
> table would live in a per-worktree DB fork, so a dropped worktree DB would
> strand its backup files forever. The filename carries the conversation id and
> time, which is all a later "undo rewind" needs.

### 3. Fork from here (server)

- `createConversation` body (`plugins/conversations/core/endpoints.ts`) gains
  `forkAtMessageUuid?: string`, valid only with `forkFromConversationId`
  (zod refinement, so the invalid combination is rejected at the boundary).
- `prepareConversation` (reads only) finds the chain file containing the uuid,
  runs `cutTranscriptAt`, and mints the new session uuid. A failed cut throws a
  typed error → 4xx, nothing created.
- `finishConversation`'s reuse branch writes
  `<anchorDir>/<newSessionId>.jsonl` — the kept lines with the source session
  id string replaced by the new one — then spawns with
  `{ resumeSessionId: newSessionId, forkSession: false }`. No initial prompt,
  so the pane opens idle.
- The preprompt guard (`if (preprompt && !resumeSessionId)`) already prevents
  a doubled `<special_instructions>` block on this path.
- `ConversationRuntime.create` and the tmux runtime need **no change**.

### 4. Endpoints and plugin

New plugin `plugins/conversations/plugins/conversation-view/plugins/rewind/`,
beside `fork-session` and `resume`:

- `core/` — two endpoint contracts:
  - `POST /api/conversations/:id/rewind/preview { uuid }` →
    `{ ok: true, messageText, losses, turnRunning } | { ok: false, reason }`
  - `POST /api/conversations/:id/rewind { uuid }` →
    `{ ok: true, rewindText } | { ok: false, reason, message }`
- `server/` — handlers calling `@plugins/conversations/server`, the
  `conversation_rewinds` table, the backup data dir, the retention job.
- `web/` — one `JsonlRowActions.Item` gated on `event.kind === "user-text"`
  (the same "real user turn" predicate the outline uses) and on the
  conversation having a session id. It renders a two-item menu.
- `CLAUDE.md` — why this does not reuse `fork-session` (that one is the CLI's
  own whole-history `--fork-session`; this one cuts), the unprompted-turn
  behaviour, and the pending-turn note below.

### 5. Web flow

- **Carrying the cut point.** `JsonlEvent` does not expose the transcript line
  id today. Add optional `uuid` to the `user-text` variant in
  `transcript-watcher/core/protocol.ts` and set it in
  `transcript-watcher/server/internal/parse-jsonl.ts`. Additive: `eventKey`
  does not use it.
- **Rewind to here.** Call preview. If there are losses or a turn is running,
  show `confirmDialog` (`primitives/overlay/imperative-dialog/confirm`) listing
  them in plain words: "2 later messages are dropped", "the report from
  *<agent>* is lost — the agent will be told it failed", "*<agent>* is still
  running and will be stopped", "files in the worktree are not changed".
  Otherwise go straight through. On success:
  `writeDraft("conversation:prompt", rewindText, { scope: convId })` — exactly
  what the Stop button does.
- **Fork from here.** Reuse `LaunchControl` with
  `getRequest: () => ({ forkFromConversationId, forkAtMessageUuid })`.
  `LaunchRequest` in `primitives/launch/web/components/launch-control.tsx` is a
  hand-written type and needs the new optional field; the value then passes
  through the existing spread. In `onLaunched`, write the message text as the
  new conversation's draft. Same preview + dialog when the cut loses something.

### Known behaviours to document, not fix

- **Unprompted turn after respawn.** When the kept history contains an agent
  launch with no result, the CLI runs one turn on its own. The poller reads it
  as a normal `working` state; nothing keys on "a user message came first".
- **Pending-turn false flag.** If a just-sent turn is cut before its
  confirmation deadline, `pending-turn` can mark it "didn't land". Rewind
  should clear the conversation's pending-turn records as part of step 4; if
  that seam does not exist, note it in the plugin doc (it self-heals on TTL).

## Critical files

- `plugins/conversations/server/internal/claude-transcript.ts` — cut primitive; `rewindLastUserTurn` refactor
- `plugins/conversations/server/internal/lifecycle.ts` — `rewindConversationAt`; fork-at-uuid in prepare/finish
- `plugins/conversations/server/index.ts` — export the new lifecycle entry
- `plugins/conversations/core/endpoints.ts` — `forkAtMessageUuid` on `createConversation`
- `plugins/conversations/plugins/transcript-watcher/core/protocol.ts`, `server/internal/parse-jsonl.ts` — `uuid` on `user-text`
- `plugins/primitives/plugins/launch/web/components/launch-control.tsx` — `LaunchRequest.forkAtMessageUuid`
- `plugins/conversations/plugins/conversation-view/plugins/rewind/**` — new plugin
- Reference only: `plugins/infra/plugins/trash/server/internal/purge.ts` (retention shape), `conversation-view/plugins/fork-session`, `push-and-exit-button.tsx` (draft prefill)

## Implementation order

1. Cut primitive + unit tests (pure, fixture transcripts: plain cut, abandoned
   branch, queue-operation block, lost report, running agent, compaction root).
   Refactor `rewindLastUserTurn` onto it; its existing behaviour must not change.
2. `uuid` on `user-text` events.
3. Fork from here end to end (smallest blast radius: the source is untouched).
4. Rewind plugin: table, data dir, retention, preview + rewind endpoints.
5. Web row action, dialog, draft prefill.

## Verification

- `./equin test plugins/conversations` for the cut primitive and the
  Stop regression.
- `./equin build`, then in the deployed worktree app, on a throwaway
  conversation (Haiku or Sonnet):
  1. Three plain turns → **Fork from here** on turn 2: new conversation shows
     only turn 1, draft holds turn 2's text, the original is unchanged. Ask
     "what did I say so far?" to confirm the model's view.
  2. Same → **Rewind to here** on turn 2: same conversation now ends after
     turn 1, draft prefilled, status returns to waiting. `query_db` shows one
     `conversation_rewinds` row and an unchanged `claude_session_id`; the
     backup file exists.
  3. The agent scenario from this investigation: launch a slow background
     agent, send a follow-up, let the agent report, rewind to the follow-up.
     The dialog must name the lost report; after confirming, the conversation
     shows the CLI's "didn't finish" notice and one unprompted turn.
  4. Rewind while a turn is running: dialog warns, turn stops, rewind lands.
  5. Refusals leave everything untouched: bogus uuid; a conversation whose
     worktree was removed.
- Cost sanity: the first request after a rewind reports cache read ≈ the kept
  context and near-zero cache creation (visible in the transcript's usage).
- An E2E script at
  `plugins/conversations/plugins/conversation-view/plugins/rewind/e2e/rewind.ts`
  covering cases 1 and 2.

## Follow-ups (not in this plan)

- **Restore files too.** The CLI has a hidden standalone operation,
  `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude -p --resume <id> --rewind-files <user-message-uuid>`.
  In-place rewind keeps the session id, so the checkpoints stay addressable.
  Untested: whether it restores checkpoints written by an *interactive*
  session. Checkpoints cover only the edit tools, not shell commands.
- **Undo a rewind** from the `conversation_rewinds` backup.
- **Carry a lost report forward** by pasting it into the draft, since the
  subagent's own transcript survives in `<session>/subagents/`.
- **Long term:** a second runtime on the Agent SDK beside the tmux one, where
  resume-at-message and file rewind are first-class calls.
