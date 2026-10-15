# Turn ledger: the server records every turn, the CLI confirms it

## Context

The "Not confirmed — the agent may not have received this message" card is a
false alarm far more often than not. Of the 16 `turn-unconfirmed` reports filed
between 2026-10-08 and 2026-10-15, **none** was a lost turn:

| Shape | Cases | Cause |
|---|---|---|
| Row landed 1–2 s after the send, exact text, still flagged | ~7 (several Push & Exit) | Matching only runs while `jsonl-pane` is mounted (`reconcilePendingTurns` in its effect); the 90 s timer runs regardless. |
| Agent busy; turn landed 1 s – 44 min later | 5 | The 90 s deadline assumes the agent takes the turn immediately. |
| CLI saw different text: stale draft prefixed, leading `>` dropped, `<pasted_content>` wrapper | 3–4 | Exact-text identity breaks on any mutation. |

The triggering case (conv-1792062801-go1pyq, 11:42–11:44):

1. Push & Exit typed P; the CLI submitted it (status `working` 11:42:48).
2. Stop → `handleStop` → Escape + `rewindLastUserTurn` truncated P from the
   JSONL and returned it → the web set it as the draft. **The CLI also restored
   P into its own input box** (Escape before any reply) — nobody cleared that copy.
3. The user sent B. `tmux-runtime.send()` either missed the draft or sent C-c
   without verifying the box emptied, then typed B → the CLI submitted `P+B`
   as one turn.
4. The browser looked for a row equal to B, found `P+B`, and after 90 s said
   "Not confirmed" while the agent was already working.

Every past fix (send watermark, never-revert, fixed point, typed-not-pasted,
held turns) patched an edge of the same inference: **the browser guesses "did
the CLI accept these exact bytes" by text-matching a transcript, and only while
one view is mounted.** Three structural flaws:

1. Identity by text match against a transcript that rewrites the text.
2. Verification lives in the browser and depends on what is mounted.
3. "Accepted" is assumed to mean "in the transcript within 90 s".

Plus one real delivery bug: sends to the same pane are not serialized, and
nothing guarantees the input box is empty before typing.

**Outcome:** a server-side ledger row per turn, whose acceptance comes from the
CLI itself (the `UserPromptSubmit` hook carries the exact submitted prompt), and
a send path that cannot type into a non-empty box. No transcript text matching
and no confirmation deadline.

## Step 1 — CLI experiments (before any code)

The design rests on CLI behaviours not yet verified on the current version.
Probe them in a scratch tmux session running `claude --model haiku` in a temp
dir, with `--settings` whose `UserPromptSubmit` hook appends its stdin to a log
file. Drive it with the same `send-keys -l` chunking as `typeTurn`.

The probe is a script at `plugins/conversations/plugins/turn-ledger/scripts/cli-probe.ts`
(leaf `scripts/` folder), run with `./singularity run`. Record the results in a
`## Findings` section appended to this doc.

| # | Question | Design decision it gates |
|---|---|---|
| E1 | Does `UserPromptSubmit` fire on a typed submit? Payload fields (`prompt`, `session_id`, …)? Is `prompt` byte-exact for multi-line text, `@/abs/img.png` tokens, a leading `>`, a leading `/`? | The match rule; whether any normalization is needed |
| E2 | Submit, then Escape before any reply: is the text restored into the box? Is a user row written to the JSONL before our rewind? Does re-submitting fire the hook again? | The `returned` state; the Stop flow |
| E3 | Send while the agent is busy: when does the hook fire (on enqueue, or on dequeue)? Two queued messages: one hook with the texts joined, or two? | The `queued` state; the merge rule for queued turns |
| E4 | Initial prompt passed as a CLI arg (held turn as launch message): does the hook fire? | Held turns delivered at launch |
| E5 | `--resume` with the settings: does the hook fire? | Rollout to hibernated sessions |
| E6 | C-c immediately followed by typed chunks on a non-empty box: does it reproduce `old+new`? Does C-c → poll until `""` → type prevent it? | Confirms the root cause and the fix |
| E7 | Hook cost: a file-writing hook vs a `bun` script — latency added to submission | Choice of hook transport |
| E8 | Slash commands (`/compact`) and `!` bash mode: does the hook fire? | Which rows can never confirm (mark them `hookless`) |

**Stop rule:** if E1 fails (no hook, or `prompt` not exact), stop and revisit
the design with the user. The rest of this plan assumes E1 holds.

### Findings (2026-10-15, Claude Code v2.1.300, haiku, scratch tmux session)

The probe was run by hand with `tmux send-keys -l` / `Enter` / `Escape` / `C-c`
against a `UserPromptSubmit` hook running `cat > <dir>/<ts>-<pid>.json`. It was
not committed as a script: `./singularity run` refuses files outside the
checkout, and the probe is a one-off.

| # | Result |
|---|---|
| E1 | **Holds.** The hook fires on a typed submit. Stdin keys: `prompt`, `prompt_id`, `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `scratchpad_dir`. `prompt` is byte-exact for multi-line text, a leading `>` and an `@/abs/x.png` token. For an idle submit, `prompt_id` equals the transcript row's `promptId`. |
| E2 | Escape right after submit (before any reply) **puts the text back in the input box**. The JSONL user row **stays** in the file; it is our Stop's `rewindLastUserTurn` that removes it, which is why the incident had no row for P. Re-submitting fires the hook again with a **new** `prompt_id`. |
| E3 | Sent while the agent is busy: the hook fires **at Enter**, not at dequeue, carrying the *running* turn's `prompt_id`. The CLI writes `queue-operation enqueue` and then injects the message into the running turn as a `queued_command` attachment (`remove` ops). There is no separate user row and no second hook. ⇒ "Accepted by the CLI" happens at Enter whether the agent is idle or busy; the "late arrival" class disappears. |
| E4 | A prompt passed as the launch argument fires the hook (`prompt` = the full argument). |
| E5 | `--resume` with `--settings`: the hook fires. Resumed sessions pick up the new hook. |
| E6 | **Not reproduced.** C-c then immediate typing, on a restored 674-character multi-line Push & Exit draft, cleared the box cleanly, and the app's parser reads that draft as non-empty (normal intensity, not faint). Why the incident's send failed to clear the box is still unknown; it was under load, with a background shell. The verified-empty guard (Step 2) and the `merged` verdict (Step 3) make it impossible to stay silent next time, whatever the cause. |
| E7 | A `cat > file` hook adds no visible latency: the hook file and the transcript row fall in the same second. |
| E8 | Slash commands (`/cost`) and `!` bash mode **do not** fire the hook. |

**Design consequences** (applied below):
- Drop the `queued` state: the hook confirms a busy-agent turn as quickly as an idle one.
- A turn whose `typedText` starts with `/` or `!` can never be confirmed, so it is
  `hookless` by construction.
- `prompt_id` is not a usable turn id (queued turns share the running turn's), so
  matching stays "oldest typed row, compare text". With sends serialized, that is
  unambiguous.
- Stop must clear the CLI's restored copy: E2 shows the CLI always restores it,
  and our rewind already gives the web its own copy.

## Step 2 — Make sending safe (ships on its own, fixes today's bug)

All in `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`
and `plugins/conversations/server/internal/runtime.ts`:

- **One send at a time per conversation.** Add a tiny keyed FIFO mutex primitive,
  `plugins/packages/plugins/keyed-mutex` (`createKeyedMutex().run(key, fn)`,
  entry dropped when idle). None of the existing primitives fit: `coalesce` folds
  runs and `inflight` dedups. Wrap the `sendTurn`, `answerPrompt`,
  `interruptConversation` and Stop facades in `runtime.ts`, so web sends, held
  delivery and Push & Exit share it.
  - Verify the held-turn job runs in the same process as the HTTP handlers. If
    not, use a pg advisory lock, generalizing `withDeliveryLock` in `held-turns.ts`.
- **Verified-empty box before typing.**
  - `send()` becomes: `copy-mode -q` → read the draft → if non-empty, C-c and
    poll `captureInputDraft` until `""` (bounded, ~2 s, the same shape as
    `typeTurn` phase 2) → type.
  - If the box still is not empty, throw `InputNotEmptyError`. The turn fails
    loudly and nothing gets concatenated.
  - `answerPrompt` gets the same guard after its menu is cleared.
- **Stop clears the CLI's copy.** `handleStop`, under the lock: interrupt →
  rewind (existing) → **clear the input box and verify it is empty**. The web
  draft remains the only copy of the stopped text.
- Expose the guard on `ConversationRuntime` as `clearInput(id)`; the api-runtime
  stub throws "not implemented".

## Step 3 — The ledger

New plugin **`plugins/conversations/plugins/turn-ledger`** (core + server). It
absorbs `conversation_held_turns`: being held becomes a state, not a table.

**Table `conversation_turns`:**
- `id` — minted by the client, which makes the POST idempotent
- `conversationId` (fk, cascade)
- `kind` — `turn | answer | push-and-exit`
- `text` — what the user wrote; raw, for the draft and Retry
- `typedText` — exactly what reached the CLI: attachment-resolved, or the full
  launch prompt for a held turn delivered at launch
- `state`, `submittedText` (the hook's `prompt` when it differs), `error`
- `createdAt`, `updatedAt`

Index `(conversationId, createdAt)`. Retention job modelled on question-relay's
`retention.ts` (7 days).

**States:**

```
held ─┐
      ├─▶ typing ─▶ typed ─▶ accepted        (hook prompt == typedText; fires at Enter even when busy, E3)
      │                 ├──▶ merged          (hook prompt contains typedText plus extra text)
      │                 └──▶ returned        (Stop rewound it, or its text was found back in the box)
      └─▶ failed      (tmux error, InputNotEmptyError, ResumeBlocked) — Retry
typing ─▶ unverified  (typeTurn: the draft never cleared) — Retry; a late hook still resolves it
```

- Never-revert: a hook match always wins, including over `failed` and
  `unverified`. That is the old rule, now with a real signal behind it.
- **No timer anywhere.** Each verdict comes from an event: typeTurn's box check,
  the hook, or Stop.
- `hookless`: the conversation's session was launched without the ledger hook
  (legacy, or E8 cases). Its `typed` rows are terminal and render as delivered.
  A per-conversation marker is written at launch in `tmux-runtime.ts` `create()`.

**Server API:**
- `submitTurn(conversationId, {id, kind, text})` becomes the single
  implementation behind `sendTurn` / `answerPrompt`, so every server caller gets
  a row automatically:
  - `handle-post-turn.ts`
  - push-and-exit `handle-start.ts`
  - ask-user-question `handle-answer.ts`
  - `deliver-held-turns-job.ts`
  - spawn `launchWithHeldTurn`

  `acceptTurn`'s hold-on-`starting` logic moves here unchanged (row lock, state
  `held`).
- `POST /api/conversations/:id/turns/:turnId/retry` re-runs a `failed` /
  `unverified` row. Manual only, as today.
- Live collection `turn-ledger.turns` (`liveCollection` + `serveCollection`,
  filterable by `conversationId`, default window = non-terminal plus the last few
  terminal rows). Precedent: question-relay `core/resources.ts`,
  `server/internal/resource.ts`.

**Hook → server (file mailbox, no network):**
- The `UserPromptSubmit` entry in `launch-settings.ts` gains a command that writes
  its stdin to `~/.singularity/state/prompt-submits/<conversationId>.<unique>.json`
  (a new `data-dirs` declaration).
- Reasons for a file rather than HTTP:
  - it costs milliseconds and never blocks submission;
  - it survives a server restart (the file waits);
  - the transport's alphabet is already enforced by `signalDirForCommands`.
- The hook must always exit 0 and print nothing (stdout becomes model context).
- A `defineFileWatcher('turn-ledger.prompt-submits')`, modelled on
  `runtime-tmux.tmux-signals` in `signals.ts`, reads each file, matches it and
  deletes it.
- Matching: the oldest `typed` row of that conversation; compare the
  hook's `prompt` to `typedText` byte-exact (normalization only if E1 demands it).
  `equal` → accepted; `contains` → merged; no candidate → a terminal-typed prompt
  (ignored).
- Boot sweep: process leftover files.
- Before typing, `send()` checks the leftover draft. If it equals the `typedText`
  of an `accepted` row, mark that row `returned` (covers Escape pressed in the
  terminal itself).
- `userTurnSent` is emitted on `accepted` / `merged` for `kind: "turn"`, or on
  `typed` when the row is `hookless`. That preserves task-title's input.

**Reports (server-side, replacing the client `turn-unconfirmed` kind):**
- `turn-merged` — carries the extra text
- `turn-unverified`
- `turn-input-not-empty`

Each is filed where the fact is learned. Retire the
`reports/plugins/turn-unconfirmed` plugin, keeping old rows readable until they
age out.

## Step 4 — Web: render the ledger

`plugins/conversations/plugins/conversation-view/plugins/pending-turn` keeps its
barrel names, but its internals become thin:

- **Delete** `internal/reconcile.ts`, `persist.ts`, the localStorage store, the
  deadline, owner-tab adoption, and the delivery registry
  (`defineTurnDelivery` + stable ids existed only so Retry survived a reload;
  Retry is now server-side). A delivery becomes a plain function argument.
- `sendConversationTurn(conversationId, {text, delivery?})`: mints the id, adds
  an optimistic row (`primitives/optimistic-mutation`) until the live row arrives,
  then calls the endpoint.
- `usePendingTurns` = `useLive(turns, {where:{conversationId}})` merged with
  the optimistic rows. `PendingTurnCard` renders by state:

  | State | Card |
  |---|---|
  | `held` | "Waiting for the agent to start…" |
  | `typing` / `typed` | dimmed echo |
  | `accepted` | nothing — the native transcript row (or queued-message row) takes over |
  | `merged` | warning naming the leftover text |
  | `returned` | nothing — the draft is the feedback |
  | `failed` / `unverified` | Retry + Copy to draft |

- Drop the `reconcilePendingTurns` call from `jsonl-pane.tsx`.
- `useOptimisticConversationStatus` reads the ledger (the latest non-terminal
  row) instead of localStorage.
- A one-time cleanup removes the `singularity:pending-turns:*` localStorage keys.
- Keep the `no-adhoc-turn-send` lint: the optimistic echo still needs the single
  entry point.
- Rewrite `pending-turn/CLAUDE.md` around the ledger.

## Critical files

- `plugins/conversations/plugins/runtime-tmux/server/internal/{tmux-runtime,launch-settings,input-draft,signals}.ts`
- `plugins/conversations/server/internal/{runtime,handle-post-turn,handle-stop,held-turns,tables-held-turns,deliver-held-turns-job,spawn-job}.ts`
- `plugins/conversations/plugins/conversation-view/plugins/{pending-turn,push-and-exit,jsonl-viewer}/…`
- `…/jsonl-viewer/plugins/tool-call/plugins/ask-user-question/server/internal/handle-answer.ts`
- New: `plugins/packages/plugins/keyed-mutex`, `plugins/conversations/plugins/turn-ledger`
- Reuse: `captureInputDraft` / `parseInputDraft`, `defineFileWatcher`,
  `signalDirForCommands`, `liveCollection` / `serveCollection` / `useLive`,
  question-relay's retention and resource modules as templates.

## Verification

- **Unit tests:**
  - the keyed mutex: FIFO, and no leak when idle
  - the ledger transition function, which stays pure with a fixed-point matrix as
    in today's `reconcile.test.ts`
  - hook-payload matching: equal / contains / none
  - `send()`'s guard, against captured panes in `input-draft.test.ts`
- **e2e** at `turn-ledger/e2e/send-flow.ts`, against a real haiku agent on this
  worktree's deploy:
  1. Send → the row reaches `accepted` with no card left.
  2. Send while busy → `accepted` at Enter.
  3. **The incident replay:** Push & Exit → Stop → edit the draft → send. The row
     is `accepted` with exactly B, and the CLI box was empty before typing.
  4. Kill the server mid-send → on restart the mailbox file still confirms the row.
- **Fleet:** after main runs it for a few days, `query_db` on `reports` should
  show no `turn-unconfirmed` rows. Any `turn-merged` / `turn-input-not-empty`
  rows are real findings, each with its cause.

## Rollout

Step 2 ships first and stands alone. Steps 3 and 4 ship together. Sessions
launched before them are `hookless` until resumed (resume re-applies
`--settings`, as `tmux-runtime.ts:700` notes), so they degrade to "typed =
delivered" — quieter than today, never louder.
