# transcript-watcher

Single `@parcel/watcher`-based JSONL transcript watcher. Replaces the dual 500ms pollers (`turn-emitter` file reads + `watch-jsonl`) with one fan-out subscription per active conversation.

One `parcel.subscribe(CLAUDE_PROJECTS_DIR)` covers all active conversations. A per-conversation room resolves the conversation's **session chain** — every JSONL file it has run under, oldest → newest — and registers all of them in a reverse index for O(1) dispatch. A 30s reconcile timer catches any missed parcel events.

**The chain, not one file.** Claude Code relocates a live session into a new id (a fork copies its ancestor's lines; a fresh daemon-hosted session inherits nothing). `resolveConversationTranscriptPaths(conversationId)` composes the recorded chain ([`session-chain`](../session-chain)) with the projects-dir glob (`findTranscriptPath`) and is the **only** sanctioned way to go from a conversation to its files. It returns `string[]`: empty means "nothing on disk yet"; a DB or glob failure throws. Reads go through `readJsonlEventsFromChain` / `readTurnsFromChain`, which merge the chain and dedup by `uuid`.

**Writes go to the tail only.** `paths.at(-1)` is the live file `claude --resume` appends to. Anything destructive (`rewindLastUserTurn`) must target it and nothing else — truncating an ancestor corrupts the history the read path merges.

**Following a session switch.** A room resolved at subscribe time would stay pinned to the file it found. The poller calls `refreshConversationChain(conversationId)` the moment it records a new session id, which re-resolves the room and fans out; the 30s reconcile re-resolves too, as a backstop for a missed notify.

**Restart recovery**: room creation triggers an immediate seed read, so any events that landed during server downtime are delivered to subscribers on reconnect. `turn-emitter`'s `hasPendingTrigger` logic hooks into this seed callback.

## One conversation, one projects directory

A chain is a list of session ids *someone else* recorded, and it can name another
conversation's session. `resolveAnchoredChain(sessionIds)` (`anchor.ts`) is the
guard: the **first id that resolves anchors** the conversation to that
`~/.claude/projects/<dir>/`, and anything resolving elsewhere is `foreign`.
`resolveConversationTranscriptPaths` returns only `kept`, so a foreign entry can
neither be merged into the transcript nor become the write tail (which
`rewindLastUserTurn` truncates — a foreign tail is a Stop button that destroys
another agent's live file).

The invariant: **all of a conversation's sessions run in one worktree** — enforced
by `createConversation`'s `forkFromConversationId` branch
(`conversations/server/internal/lifecycle.ts`), which rejects a fork whose
`attemptId` differs from the source's and then takes the source's attempt.

**Do not replace the anchor with a derivation.** Deriving the expected dir from
`attempts.worktree_path` through Claude's cwd→dirname encoding (`/`, `_`, `.` →
`-`) looks tighter, but nothing in this repo re-implements that encoding, so
nothing would notice if Claude changed it — and the day it did, it would match
nothing and blank *every* conversation. The anchor's worst failure is resolving
one fewer id, which this path already does daily for GC'd transcripts.

A refusal files a `conversation-foreign-session` report (kind + emitter in
`server/internal/`, schema in `core/`, renderer in `web/`), debounced 5 min per
`(conversation, session)` — the read path runs on every push, so the debounce is
in *front* of `recordReport`, and the emitter never throws into the read. The
read self-heals; the DB row does not, which is what the report is for. Its
`shared-session-id` arm is filed by `debug/session-divergence`'s pure-SQL
detector — same corruption, two discovery routes. Design:
[`research/2026-08-19-global-pane-session-ownership.md`](../../../../research/2026-08-19-global-pane-session-ownership.md).

## The chain signature, and why a listener gets `{ events, signature }`

`transcriptChainSignature(paths)` (`chain-signature.ts`) is the **single definition of
"did the chain change?"** — `chainLength` plus a per-file `(path, lstat mtime+size)`
triple. It is the room's sole change-detector, and it is what `watchTranscript`'s
listener receives alongside the events, as one `TranscriptSnapshot`.

The pair is inseparable **by construction**: `processRoom` captures the signature
*before* `readJsonlEventsFromChain`, and assigns `lastEvents` / `lastSignature`
together only after that read succeeds. So the signature always describes a snapshot
**no newer** than the events it accompanies. That is exactly
`createSignedMemo.prime`'s precondition, which is why `jsonl-events` can prime its
memo straight from the callback: an append landing mid-read leaves the signature
*older* than the value, the next `get` re-probes, misses, and recomputes — over-
invalidating by one read, never serving a torn value under a matching signature.

Hand the two halves out separately and a consumer will reassemble a mismatched pair;
that is precisely the bug this shape removes. See
`research/2026-07-10-conversations-jsonl-events-shared-authority.md`.

**Use `lstat`, never `Bun.file().lastModified`.** The latter is integer-ms, the former
a sub-ms float, so the two yield different strings for the same file. Every producer
of a chain signature routes through `transcriptChainSignature`; only the bound
function is exported, because a consumer assembling its own signature from `statChain`
and `chainEtag` would be a second authority. Split them and the watcher's primed
signature never matches the resource's probe: every prime misses silently and the
memo degrades to a full chain re-read on every push.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Foreign-session report renderer: a one-line Debug, Reports summary for the conversation-foreign-session kind — which conversation holds a session id that belongs to another, and how it was seen. Single @parcel/watcher-based JSONL transcript watcher. Replaces two independent 500ms pollers with one fan-out subscription.
- Web:
  - Contributes: `Reports.KindView` → `ForeignSessionSummary`
  - Uses:
    - `primitives/css/badge.Badge`
    - `primitives/css/inline.Inline`
    - `reports.Reports`
- Server:
  - Contributes: `report-kind` "conversation-foreign-session"
  - Uses:
    - `conversations/session-chain.listSessionChain`
    - `infra/file-watcher.defineFileWatcher`
    - `infra/file-watcher.FileWatcher`
    - `infra/paths.CLAUDE_PROJECTS_DIR`
    - `reports.DEFAULT_REPORT_DEBOUNCE_MS`
    - `reports.recordReportDebounced`
    - `reports.ReportKind`
    - `tasks/tasks-core.getConversationClaudeSessionId`
  - Exports (types):
    - `AnchoredChain`
    - `AnchoredEntry`
    - `PathsSnapshot`
    - `TranscriptSnapshot`
    - `WatchSpec`
    - `WatchTargets`
  - Exports (values):
    - `conversationChainTag`
    - `findTranscriptPath`
    - `onSessionTranscriptWritten`
    - `onTranscriptWritten`
    - `readChainLines`
    - `readJsonlEvents`
    - `readJsonlEventsFromChain`
    - `refreshConversationChain`
    - `resolveAnchoredChain`
    - `resolveConversationTranscriptPaths`
    - `transcriptChainSignature`
    - `watchPaths`
    - `watchTranscript`
    - `watchTranscriptFile`
  - Register: `defineFileWatcher('transcript-watcher.transcripts')`
- Cross-plugin:
  - Imported by:
    - `apps/prototypes/checkpoints`
    - `backup/sources/transcripts`
    - `conversations`
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversation-view/jsonl-viewer/background-shells`
    - `conversations/conversation-view/jsonl-viewer/subagents`
    - `conversations/transcript-api`
    - `conversations/transcript-retention`
    - `conversations/usage`
    - `debug/session-divergence`
- Core:
  - Exports (types):
    - `ForeignSessionPayload`
    - `JsonlEvent`
    - `QuestionAnswer`
    - `RequestConfig`
    - `RequestConfigChange`
    - `RequestConfigScalarField`
    - `TeammateMessage`
    - `TokenUsage`
    - `ToolCallResult`
    - `UserTextSegment`
  - Exports (values):
    - `activeLineUuids`
    - `extractPreprompt`
    - `extractTeammateMessages`
    - `ForeignSessionPayloadSchema`
    - `isInterruptContent`
    - `JsonlEventSchema`
    - `PREPROMPT_TAG`
    - `QuestionAnswerSchema`
    - `requestConfigChanges`
    - `RequestConfigSchema`
    - `stripRelayBoilerplate`
    - `tokenUsageOf`
    - `TokenUsageSchema`
    - `unwrapPastedContent`
    - `unwrapRelayEnvelopes`
    - `userPromptText`
    - `wrapPreprompt`

<!-- AUTOGENERATED:END -->
