# Sonata transcription on the embedded agent thread

Task: task-1792552540-45alnd · Track: "Universal search" (block-ef922c48-b280-4db9-861a-f60d99c7c5b2) ·
Design: "Embedded conversation view" → *Migration candidate: Sonata transcription* (block-b8192e78-a010-421e-8443-c7d0ba327b3c) ·
Reference client: Places Ask Sonnet (research/2026-10-21-apps-places-ask-sonnet.md, merged 8c593632af).

## Context

Today Sonata's transcription shows a background agent run as a bespoke panel, `TranscriptionBody`
(`apps/sonata/plugins/transcription/web/components/transcription-body.tsx`). It has a spinner and a sentence, the error,
Retry and Open conversation. For everything else the user has to go to the Agent Manager: they cannot follow the agent's
steps, and they cannot reply ("bar 12 is wrong") from Sonata. `conversations/agent-thread` now exists and has run live
with Places, so this task moves the transcription onto it:

- **While transcribing or failed**, the player's pending body is an `<AgentThread>`.
- **Once the score is in**, the same thread lives in a **Transcription** section of the player, so the user can ask for
  corrections. A resubmitted score replaces the song's score in place.

**The behavioural change** is that the agent ends its turn instead of calling `exit_clean`, so the conversation stays
repliable. Decided with the user:

- A transcription task reads **done as soon as the score is delivered**, while the conversation stays open and
  continuable.
- It reads in progress only while a correction is actually running.

## Changes

### 1. tasks-core: a delivery completes an idle attempt (`tasks/tasks-core`)

Today `completed` is `hasPush AND NOT hasLiveConv`, and a delivery is folded into `has_push`. An end-turn agent sits at
`waiting`, which counts as live. So a delivered transcription would read `pushed` and its task `need_action` until
hibernation, then flip back on every reply.

- `rollup-spec.ts`:
  - `attempt_push_agg` gains `has_delivery`: `bool_or(kind = 'delivery')`, with a `kind` tag added to the UNION arms.
  - `attempt_conv_agg` gains `has_working_conv`: `bool_or(status IN ('starting','working'))`.
  - The columns go in `rollup-table.ts`, and their migration comes from `./singularity build`.
- `derived.ts` `attemptDerived` gets one new arm, right after `in_progress`:
  `WHEN hasDelivery AND NOT coalesce(hasWorkingConv,false) THEN 'completed'`.
  - A delivered attempt whose conversation is idle (`waiting`), hibernated or closed is `completed`, so its task is
    `done`.
  - While a correction runs, it is `pushed`, so the task is `in_progress`.
  - Pushes (git) keep today's rule.
  - `retained` is unchanged (`has_open_conv`), so nothing destructive treats the open conversation as finished.
- `AttemptFacts` gets the two facts, threaded through `views.ts`, `attempt-rows.ts` and `task-rows.ts` (`factsOf`).
- Update the comments that claim done needs a close: `rollup-spec.ts:40`, the `views.ts` I6 block, and the
  `deliveries.ts` docstring.
- `views.test.ts`: extend the status truth table with delivery × {working, waiting, gone, done}.
- Audit readers of `attempt.status === 'completed'` and task `done` that assume no live conversation behind them, and
  note the result in the outcome. Known: `taskDerived.active` is already `NOT hasCompleted AND hasActive`.

### 2. transcription server (`apps/sonata/plugins/transcription/server`)

- **Result kind in core** (`core/`): `sonataScore = defineThreadResult({ tool: SUBMIT_TOOL, schema: SubmitSchema })`,
  where `SubmitSchema` is `{ path }`, today's input. Move `SUBMIT_TOOL` to core.
  - `mcp-tool.ts` uses `SubmitSchema.shape` as its `inputSchema`, so the server and the web parse one schema (the
    Places `placesPicks` pattern).
- **`profile.ts`**: `mcpTools: [SUBMIT_TOOL, "flag_raise"]`, dropping `exit_clean`.
- **`instructions.ts`**, step 6:
  - After a successful submit, write the two-line summary and end your turn. Never call `exit_clean`, because the user
    may reply.
  - New section **"When the user replies"**: they are pointing at a mistake ("bar 12 is wrong"). Re-read that part of
    the source, fix `score.musicxml`, render it, compare side by side, and submit again.
- **`mcp-tool.ts`**: the description and the success text say "end your turn" instead of "call exit_clean".
- **`submit.ts` / `state.ts`**: a resubmission on a `ready` song re-imports the score and calls `markReady` again.
  - `importMusicXmlForSong` already overwrites, and `updateSongMeta` re-hydrates an open player.
  - `recordScratchDelivery` is idempotent per attempt.
  - Make sure `markReady` (`markReadyKeepingInputs`) is safe to repeat, and add a `submit.test.ts` case for it.
- **`conversation-status.ts`**:
  - Keep "closed (`done`) before a submit → failed".
  - Add: when a `failed` song's own conversation goes `working` again (the user replied through the thread composer,
    which resumes a `done` conversation), call `markTranscribing`, so the badge and the pending label follow the run.
  - Ready songs are ignored, as today.
- **`profile-input.test.ts`**: assert the end-turn wording, and that `exit_clean` is absent.

### 3. transcription web (`apps/sonata/plugins/transcription/web`)

- **`TranscriptionBody`**, the pending body for `transcribing` and `failed`:
  - `conversationId === null` (not started yet, or the launch failed): keep the short state line, with Retry when
    failed.
  - Otherwise: `<AgentThread conversationId results={RESULTS} title="Transcription" resultWords={…} renderResult placeholder="Reply — e.g. bar 12 is wrong" headerAction={failed ? <Retry/> : undefined}/>`.
  - Open conversation comes with the thread header, so the hand-rolled `OpenConversation` is deleted.
  - `RESULTS = [sonataScore]` at module level, as in Places.
- **`renderResult`**: a small "Score in" card: a check, "Score submitted · `score.musicxml`", and the time.
  - On older turns (`latest: false`) it is a muted "Earlier version" line.
  - There is no "open" action: the player swaps to the score on its own.
- **Height**: `AgentThread` fills its container.
  - The library's pending layout (`library/web/panes.tsx:323`) gives the pending body the pane's remaining height (a
    fill region instead of an auto-height `Stack` child). The `css` skill shows how.
  - This is the one change outside the plugin on the web side.
- **New `Sonata.Section`** `{ id: "transcription", label: "Transcription", area: "editor", component: TranscriptionSection }`:
  - `useAvailable`: the mounted song (`useMountedSongId`, `sonata/document`) has a transcription conversation, read
    with `useLiveRow(songLibrary)` and the exposure's `conversationId`.
  - The body is the same `<AgentThread>` in a bounded box (≈ 28rem), so corrections work on a ready song.
  - If `DetailSection.summary` allows it, the summary reads `useThreadProgress` ("working · step N" / "score in").
  - A collapsed section unmounts, which is fine: the run lives on the server.
  - Factor a `TranscriptionThread({ songId, conversationId, failed })` used by both mounts.
- Not done: Bash step labels. `AgentThreadSlots.StepLabel` matches by tool name for every host, so labelling `./bin/st …`
  calls would mean hijacking `Bash` globally. The generic label (the command) stays, and this is noted as a follow-up
  (a profile-scoped label match in agent-thread).

### 4. Docs

- Rewrite the flow steps 4–5 and the "derives done" paragraph in `transcription/CLAUDE.md`.
- Add a "Delivery completes an idle attempt" line to tasks-core's docs.
- At the end, update the track page: the status line, ticking the Sonata checkbox, and the design page's migration
  section. Then file the next main task on the track (only one).

## Critical files

- `plugins/tasks/plugins/tasks-core/server/internal/{rollup-spec,rollup-table,derived,views,attempt-rows,task-rows}.ts`, plus `views.test.ts`
- `plugins/apps/plugins/sonata/plugins/transcription/core/{index,result}.ts` (new `sonataScore`)
- `…/transcription/server/internal/{profile,instructions,mcp-tool,submit,conversation-status}.ts`, plus tests
- `…/transcription/web/{index.ts,components/transcription-body.tsx}`, plus the new `components/transcription-thread.tsx` and `transcription-section.tsx`
- `plugins/apps/plugins/sonata/plugins/library/web/panes.tsx` (the pending body fills)

Reused as is: `AgentThread`, `useThreadProgress`, `defineThreadResult` (agent-thread), `useMountedSongId`, the
`Sonata.Section` contract, `retryTranscription`, `recordScratchDelivery` and `importMusicXmlForSong`.

## Verification

1. `./singularity test plugins/tasks/plugins/tasks-core plugins/apps/plugins/sonata/plugins/transcription plugins/conversations/plugins/agent-thread`.
2. `./singularity build`, then drive the worktree with `browser_*`:
   - Transcribe a small one-page PDF or image. The pending body shows the live thread (Bash steps, the answer), then
     swaps to the score on submit.
   - The task reads **done** in the Agent Manager while the conversation is waiting.
   - Open the player's Transcription section and reply "bar 2 is wrong". The task reads in progress, the agent
     resubmits, the score updates in place, and the task is done again. The old result shows as "Earlier version".
   - Failure: Exit the conversation from the Agent Manager before it submits. The song shows Failed with the thread,
     and Retry is in the header. A reply through the composer brings the song back to Transcribing.
   - Open conversation lands on the same conversation in the Agent Manager.
3. Take screenshots of the pending thread, the section and the failed state.

## Outcome (as built)

`./singularity test` on tasks-core, transcription and agent-thread is green (175). The change was verified live on the
worktree build with a song transcribed before this change (song-1792261574-oejpvy):

- The player's Transcription section showed the old run as a thread: the request, 42 steps folded, "score in", the
  agent's summary and the reply box.
- **Reply 1:** "The last chord looks wrong…". The reply resumed the closed (`done`) conversation, and the task read
  `in_progress` (attempt `pushed`) while the agent worked. The agent checked the chord, found it correct, explained why
  and ended its turn. The task then read `done` (attempt `completed`) while the conversation stayed `waiting`.
- **Reply 2:** "set the tempo to quarter = 60 and resubmit". The agent resubmitted, "Score in" showed on the new turn,
  and the old turn's score read "Earlier version". The song's `sources_changed_at` moved, so the player re-hydrated
  with the new score. The task read `done` again.

Deviations from the plan:

- The library's pending layout was not changed. The thread sits in a bounded box (`min(40rem, 75vh)` in the pending
  body, `min(32rem, 60vh)` in the section), the same way Places does it.
- In the section the thread has no title of its own, because the section header already names it.
- The Transcription section is placed first in the player's section column, with the song's sources
  (`config/apps/sonata/shell/section.jsonc`).

Not verified live:

- The pending body while a run is transcribing or failed: no such song existed in the worktree DB, and a fresh run
  needs the `st` dependency and a full agent session. It is the same `TranscriptionThread` component as the section.
- The failed → transcribing re-mark: covered only by reading the code.

Audit of consumers of `done` / `completed`:

- The `taskStatusChanged` triggers (auto-start, queue rerank, automations, sidequest autopilot) only launch or rerank.
  None of them closes a conversation or reaps a worktree.
- Retention reads `retained` (`has_open_conv`), which is unchanged.
