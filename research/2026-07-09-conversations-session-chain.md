# Conversation session chain — fix the frozen transcript

## Context

The conversation view can render a Claude transcript frozen hours in the past while the terminal
(attached to the live tmux pane) shows the real, ongoing conversation. Measured on
`conv-1783448623-h424`: `GET /api/conversations/conv-1783448623-h424/turns` returns 64 turns ending
`2026-07-08T10:43:35`, while the agent kept talking until `23:10:58` — **747 minutes of messages
invisible in the UI**.

### Root cause (verified by executing the code against the live host, not by reading it)

1. `resolveSessionState(panePid)` in
   [`plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`](../plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts)
   reads `~/.claude/sessions/<panePid>.json` and **returns early** whenever that file yields a
   `sessionId` (lines 91–97). Its fallback (`pgrepChildren`) walks **one level** of children only.
   Positive results are pinned forever in a module-level `pidCache` (lines 10, 78–89).
   `forgetPid()` (line 112) is exported and **never called anywhere in the repo**.

2. Claude Code can relocate a pane's live session into a daemon-hosted process. Observed tree:

   ```
   99082  claude --resume 4a4671db          ← pane_pid: launcher/TUI, v2.1.202
    5302   claude daemon run
     5330   ClaudeCode.app --bg-pty-host
      5414   versions/2.1.205 --session-id af01a393   ← the real agent, kind: "bg"
   ```

   The live session is **three levels below** `pane_pid`.

3. `~/.claude/sessions/99082.json` is a tombstone — last written `12:30:26`, still names
   `4a4671db`, never deleted. So `resolveSessionState(99082)` returns the dead id. *(Confirmed by
   running the real function against pid 99082.)*

4. The adoption gate at [`poller.ts:161-166`](../plugins/conversations/server/internal/poller.ts)
   therefore never sees a new candidate; `conversations.claude_session_id` stays pinned;
   `findTranscriptPath` resolves the dead file; every downstream consumer renders it.

### The conversation spans three session files, not one

```
4a4671db   18:24 → 10:43   ← what the DB points at / what the UI shows
fcd9c7bc   14:18 → 18:58   ← hidden. Forked: contains a full copy of 4a4671db's lines
af01a393   22:54 → 23:10   ← hidden. Fresh: inherits nothing
```

There is **no way to reconstruct the chain from Claude's own artifacts**. Transcripts carry no
forward/back pointer (`af01a393` mentions neither predecessor anywhere). `~/.claude/history.jsonl`
is keyed by `project` (cwd), and a worktree hosts several conversations — `att-1783448623-8a1e` also
runs `conv-1783520275-fvv3` on session `f0f75ceb`, prompts interleaved in that same file. So
cwd-ordering cannot separate two conversations sharing a worktree. **The chain must be recorded by
us, append-only, as the poller observes each id change.**

### Scope check (measured, so the fix doesn't over-fit)

Of 23 live Claude sessions on this machine, **22 are `kind: "interactive"` with `pane_pid` == the
session process**; exactly one is `kind: "bg"`. A subtree walk therefore degenerates to `pane_pid`
for every healthy pane. Selection must come from the **subtree walk**, never a "freshest file
globally" heuristic — an idle interactive session can go 58 days without a write, so `updatedAt`
alone is not a staleness signal.

### Non-reproducible trigger

The handoff happened once, correlating with a CLI self-update (`2.1.202` in the tombstone vs
`2.1.205` running) and a job `reapedMidWorkAt`. **It cannot be reproduced on demand.** Stage 1 is
unit-testable against a synthetic process tree; the end-to-end migration is not. That is why the
Stage 3 detector is not optional — it is how we learn whether the fix held.

---

## Stage 1 — Correct live-session resolution

**New** `plugins/conversations/plugins/runtime-tmux/server/internal/process-tree.ts`

- `type ProcessLister = () => Promise<Array<{ pid: number; ppid: number }>>`
- `captureProcessTree(lister?): Promise<ProcessTree>` — one `ps -axo pid=,ppid=` snapshot parsed into
  `Map<ppid, pid[]>`. One `ps` per poller tick beats N recursive `pgrep`s.
- `subtreePids(tree, root): number[]` — BFS, returns `[root, ...descendants]`. Pure, trivially testable.

**Rewrite** `claude-session.ts`

- `resolveSessionState(panePid, tree, deps = { readSessionFile, statSessionFile })`
- For every pid in `subtreePids(tree, panePid)`, read `~/.claude/sessions/<pid>.json`; keep candidates
  with a non-null `sessionId`, paired with the file mtime; **return the max-mtime candidate**.
- No candidate → `NULL_STATE` (legitimate: Claude hasn't written a session file yet; retried next tick).
  A lister/stat failure **throws** — `tmux-runtime.ts:585-596` already catches and `recordReport`s.
- **Delete `pidCache` and `forgetPid` entirely.** The permanent pin is the bug's amplifier, and pid
  reuse makes it a live hazard. Re-resolving every tick is one `ps` plus a few small reads.
- `resolveClaudeSessionId` stays as the thin wrapper.

**Callers** `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`

- `list()` (line 579) captures the tree **once** and passes it to each `resolveSessionState` in the
  existing `Promise.all` (583–597).
- `paneIsWorking()` (line 554) captures its own tree before its single call (line 559).

**Tests** (co-located `bun:test`, per the repo's pure-logic convention)

- `process-tree.test.ts` — `subtreePids` on hand-built trees.
- `claude-session.test.ts` — injected readers:
  - healthy: session file only at root, 58 days old → returns it (freshness is *within* the subtree).
  - broken: `root→a→b→c`, stale tombstone at `root`, fresh file at `c` → returns `c`'s id.
  - no session files → `NULL_STATE`; lister throws → propagates.

> Stage 1 must **not** ship alone. Once the poller can see the new id it will overwrite
> `claude_session_id`, trading "frozen 12h" for "only the newest segment, prior history silently
> dropped." Land it with Stage 2.

---

## Stage 2 — The session chain + chain-aware read path

### 2a. New sub-plugin `plugins/conversations/plugins/session-chain/`

A leaf DB primitive: `conversationId → ordered claude session ids`. It knows nothing about file
paths, which keeps the import graph a DAG (`transcript-watcher` composes it with `findTranscriptPath`).

`server/internal/tables.ts` — `defineEntity("conversation_sessions", …)`, modeled on the append-only
soft-FK precedent at
[`plugins/conversations/plugins/summary/server/internal/tables.ts:15-33`](../plugins/conversations/plugins/summary/server/internal/tables.ts):

```
conversation_sessions(
  id              text pk,
  conversationId  text not null,   -- soft FK, no cascade (own lifecycle)
  claudeSessionId text not null,
  seenAt          timestamptz default now()
)  index (conversationId, seenAt)
```

`server/internal/record.ts`

- `recordSessionId(conversationId, claudeSessionId): Promise<void>` — no-op when the chain tail
  already equals the id (idempotent across every 1s tick); else insert. Append-only, never updated.
- `listSessionChain(conversationId): Promise<{ claudeSessionId: string; seenAt: Date }[]>` — oldest→newest.

`entity-extensions` is **1:1 only** (`parentId` is the PK), so it cannot host this. Own `defineEntity`
is the sanctioned 1:N route — same as
[`plugins/history/plugins/engine/server/internal/tables.ts:10-35`](../plugins/history/plugins/engine/server/internal/tables.ts).

### 2b. The poller writes the chain

`plugins/conversations/server/internal/poller.ts` — inside the existing `sessionChanged` branch
(167–176), after computing `sessionCandidate`, call `recordSessionId(id, sessionCandidate)`. It reuses
the same transcript-backed gate at line 164, and the first `null → sid` transition seeds chain entry
#1 with no special case. The `conversations.claude_session_id` column keeps its meaning: **the live
tail**, used by `claude --resume`.

### 2c. Merge primitive — uuid-dedup, then the existing branch filter

**Validated empirically against the real three-file chain**, not assumed:

```
uuid overlap:  A∩B = 266 = |A|   (fcd9c7bc is a strict superset of 4a4671db)
               A∩C = 0,  B∩C = 0 (af01a393 is a disjoint root)
merged 791 lines (raw sum 1057) → activeLineUuids drops 6
lines visible today but hidden after merge:  0        ← zero regressions
segments: 18:24→10:43 | 14:18→18:58 | 22:54→23:10     ← three contiguous spans
```

Algorithm: concatenate the chain's files **in chain order**, drop duplicate `uuid`s (first wins, so
the earliest file's copy and its original timestamps survive), keep every line without a `uuid`
(metadata: `mode`, `permission-mode`, `ai-title`, `file-history-snapshot`), then feed the merged array
through the **existing** `activeLineUuids` forest filter
([`transcript-watcher/core/branch-filter.ts`](../plugins/conversations/plugins/transcript-watcher/core/branch-filter.ts)).

That filter already treats resume/compaction as disjoint root trees and drops abandoned rewind
branches, so both the 247 copied lines and any compaction boundary are handled for free.

**Rejected:** the `session_id` (snake_case) provenance stamp. It is a real discriminator — copied
lines keep the ancestor's `session_id` while the file's `sessionId` is the new one — but metadata
lines carry no `session_id` at all, and it would not do the rewind-branch filtering `activeLineUuids`
already does.

**Caveat to carry in a comment:** here the fork copied *everything* (`A ⊂ B`). A fork from a
*midpoint* would leave the ancestor's post-fork lines as a branch off the merged spine, and
`activeLineUuids` would drop them. That is arguably correct (they *are* an abandoned branch), but it
is the one place the merge can hide a line, and it should be stated where the merge lives.

Implementation:

- `transcript-watcher/server/internal/parse-jsonl.ts` — extract
  `mergeChainLines(files: {path, raw}[]): Record<string, unknown>[]`; add
  `readJsonlEventsFromChain(paths: string[])` that merges then runs the current single-pass builder.
  Keep `readJsonlEvents(path) = readJsonlEventsFromChain([path])`.
- `conversations/server/internal/claude-transcript.ts` — same split: `readTurnsFromChain(paths, since)`.
  `sinceIso` stays a post-parse filter.
- Unit-test `mergeChainLines` on all three shapes: superset fork, disjoint fresh session, midpoint fork.

### 2d. One non-absorbing resolver

**New** `transcript-watcher/server/internal/resolve-chain.ts`

```ts
resolveConversationTranscriptPaths(conversationId): Promise<string[]>
```

`listSessionChain` → map each id through `findTranscriptPath` → drop ids with no file yet (warm-up),
preserve order. **Returns `string[]`; empty means "no transcript on disk yet". Throws on DB/glob
failure.** This is the structural fix for the current `no-absorbed-failure` violations: today six
consumers do `getConversationClaudeSessionId` + `findTranscriptPath` + `return []`, so a genuine
failure is indistinguishable from an empty conversation. `findTranscriptPath` becomes internal to
the resolver. Its positive-only path cache stays (session ids are immutable once resolved).

### 2e. Consumer migrations (all chains are length-1 today ⇒ backward compatible)

| File | Change |
|---|---|
| `conversations/server/internal/runtime.ts:145-162` | `readConversationTurns` uses the resolver. **`rewindConversationTurn` truncates `paths.at(-1)` only** — the live tail. `rewindLastUserTurn` is destructive (`Bun.write`, `claude-transcript.ts:69`); truncating an ancestor would corrupt history. Document the invariant. |
| `conversations/server/internal/handle-list-turns.ts:13-16` | Keep the `undefined → 404` probe, then `readTurnsFromChain(...)`. |
| `jsonl-viewer/server/internal/jsonl-events-resource.ts` | `loader` → `readJsonlEventsFromChain`. `revalidate` etag → `paths.map(p => \`${p}:${mtime}:${size}\`).join("\|")` + chain length, so a new file *or* a new chain entry invalidates. `"none"` when empty. |
| `transcript-api/shared/endpoints.ts` + `server/internal/handle-transcript.ts` | Response `{ path: string \| null }` → **`{ paths: string[] }`**. No in-repo consumers read `.path` (grepped); it is agent-facing, so update `transcript-api/CLAUDE.md`. |
| `transcript-retention/server/internal/touch-job.ts:27-33` | `utimes` **every** path in each active conversation's chain — otherwise Claude's own `cleanupPeriodDays` GC deletes the ancestors we now depend on. |
| `backup/plugins/sources/plugins/transcripts/server/internal/assemble-transcripts.ts:20-28` | `cp` every path in the chain. |

### 2f. Watcher — re-resolvable, multi-file rooms

`transcript-watcher/server/internal/watcher.ts`

- `Room.transcriptPath: string | null` → `transcriptPaths: string[]`; register **every** chain file in
  the `pathToConvId` reverse index. `lastMtimeMs` becomes a per-file map; any file with an unseen
  mtime forces a fan-out. `processRoom` re-reads via `readJsonlEventsFromChain`.
- **Fix "resolved once, never re-resolved"** (`resolveRoom`, line 95): a live subscriber currently
  never follows a session switch until the room is torn down. Export
  `refreshConversationChain(conversationId)` which re-resolves, adds new paths to the room and the
  reverse index, and re-processes. The poller calls it right after `recordSessionId` (same process).
  The existing 30s `onReconcile` sweep also re-resolves each room, as a belt-and-suspenders path for a
  missed notify.

### 2g. Backfill

Two guarded, idempotent data migrations (generated by `./equin build`, **never** `drizzle-kit`
by hand; `migrations-in-sync` enforces):

1. **Heads for everyone** — one `conversation_sessions` row per conversation with a non-null
   `claude_session_id` (`INSERT … SELECT … ON CONFLICT DO NOTHING`).
2. **The known triple for `conv-1783448623-h424`** — insert `4a4671db…`, `fcd9c7bc…`, `af01a393…` in
   order, `WHERE EXISTS (SELECT 1 FROM conversations WHERE id = 'conv-1783448623-h424')` so it no-ops
   in every other DB fork. The middle segment is a dead session the poller can never observe live; the
   triple is verified above and assembles with zero regressions.

Mid-chain recovery stays **manual, per incident**. No general cwd/timestamp/provenance matcher —
`history.jsonl` is cwd-keyed and worktrees host several conversations, so a general matcher is
guesswork dressed as recovery.

---

## Stage 3 — Divergence detector

New plugin `plugins/debug/plugins/session-divergence/`, following the 8-file monitor pattern
(template: [`plugins/debug/plugins/queue-health/`](../plugins/debug/plugins/queue-health/),
[`plugins/debug/plugins/read-set-shrink/`](../plugins/debug/plugins/read-set-shrink/)).

- `core/kinds.ts` — payload `{ conversationId, chainTailSessionId, liveSubtreeSessionId, tailMtimeMs, liveMtimeMs }`.
- `core/config.ts` — `defineConfig({ name: "session-divergence", fields: { enabled: true, graceMinutes: 2 } })`.
- `server/internal/divergence-kind.ts` — `ReportKind({ kind: "conversation-session-divergence",
  fingerprint: p => \`session-divergence:${p.conversationId}\`, meta: { variant: "warning" }, renderTask })`.
  One deduped report per conversation.
- `server/internal/monitor-job.ts` — `defineJob({ name: "debug.session-divergence-monitor",
  dedup: "singleton", schedule: { cron: "*/5 * * * *", perWorktree: true }, maxAttempts: 3 })`.
  `perWorktree: true` because the chain rows live in each worktree's own DB fork, exactly like
  `queue-health` samples its own queue.
  `run`: capture the process tree once via **Stage 1's `captureProcessTree`** — sharing the primitive
  is what stops the detector drifting from the resolver — then for each active conversation with a
  live pane, flag when a subtree session id (a) is absent from `listSessionChain(convId)`, (b) has a
  transcript on disk, and (c) its mtime leads the chain tail's by more than `graceMinutes`. The grace
  absorbs the poller's legitimate "new session has no transcript yet" window. Silent when healthy.
- `server/index.ts` — `register: [monitorJob]`, `contributions: [ConfigV2.Register(...), kind]`.
- `web/components/session-divergence-summary.tsx` + `web/index.ts` —
  `ConfigV2.WebRegister`, `Reports.KindView({ match: "conversation-session-divergence", component })`.
- Add `"server-session-monitor"` to `SERVER_REPORT_SOURCES` in
  [`plugins/reports/core/sources.ts`](../plugins/reports/core/sources.ts).

---

## Verification

Run `./equin build` after each stage (regenerates migrations + registry), then:

**Stage 1**
```bash
bun test plugins/conversations/plugins/runtime-tmux/server/internal
```
Then confirm on the live host that the broken pane now resolves the daemon session:
`resolveSessionState(99082)` must return `af01a393…`, and all 22 healthy panes must still return
their `pane_pid`'s id.

**Stage 2**
```bash
bun test plugins/conversations/plugins/transcript-watcher
bun test plugins/conversations/server/internal
curl -s http://singularity.localhost:9000/api/conversations/conv-1783448623-h424/turns \
  | jq '{count:(.turns|length), first:.turns[0].at, last:.turns[-1].at}'
```
Expect turns spanning `2026-07-07T18:24` → `2026-07-08T23:10`, with the `14:18–18:58` middle segment
present and no duplicated content around the fork boundary.

```
mcp query_db: select conversation_id, claude_session_id, seen_at
              from conversation_sessions
              where conversation_id = 'conv-1783448623-h424' order by seen_at;
```
Expect exactly three rows in chain order.

Then drive the real UI — a passing endpoint is not a rendered pane:
```bash
bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents/c/conv-1783448623-h424 --out /tmp/chain
```
Confirm the "Did you rebuild ?" exchange is visible in the conversation view, not only the terminal.

**Stage 3**
Force a synthetic divergence (insert an older tail into `conversation_sessions` for a live
conversation), wait one cron tick, then:
```
mcp query_db: select kind, count, data from reports where kind = 'conversation-session-divergence';
```
Confirm exactly one report, and confirm silence (zero rows) for the healthy conversations.

---

## Explicitly out of scope

- **Byte-offset / incremental JSONL reads.** `readJsonlEvents` re-parses the whole file on every
  mtime change, and the chain multiplies that cost by N. A real perf concern, and a separate task.
- **Rewriting `poller.ts` off its 1s `setInterval`.** Pre-existing; don't fold it in.
- **General mid-chain recovery.** Decided above: manual per incident.
- **Whether Claude carried context across the fresh `af01a393` session.** Its transcript inherits zero
  lines, which suggests a cold context — meaning "show the user every message" and "the agent
  remembers every message" are now different problems. We can only fix the first. Testable by asking
  that agent something answerable only from before `22:54`; not a blocker for this work.

---

## Addendum — 2026-08-18: the parked-job shape

The subtree walk above closed the *daemon-descendant* shape. A second shape defeated it, on
`conv-1786969506-7e03`: **10h25m of turns written where the UI could not read them**, with the
pane showing "Working for 625m" and every message the user sent stuck at *"Not confirmed — the
agent may not have received this message"* (the pending-turn deadline waits for the message to
appear in the transcript it watches, and that transcript had stopped growing).

### What is different about it

Claude Code can **park** a pane's session as a background job. It forks the conversation to a new
session id, hands it to a `--bg-pty-host` process, and leaves a stub behind in the pane that keeps
rendering the job through the daemon socket — so the terminal advances and typed input reaches the
real agent, while the app learns nothing.

```
9948   claude --resume 9fd24c8e…            ← pane_pid; sessions file frozen 13:05,
 27243  claude daemon run --origin transient   still naming 9fd24c8e, parkedJobId "baf9c302"
  27538  claude bg-pty-host

1 (launchd)
 11404  claude --bg-pty-host …
  11536  versions/2.1.234 --session-id baf9c302… --fork-session --resume 9fd24c8e….jsonl
         ← the real agent. kind "bg", status "busy", jobId "baf9c302"
```

The live session is **not below `pane_pid` at all** — its host is re-parented to launchd. So no
walk of the pane's subtree can reach it, and no freshness comparison *within* the subtree helps:
the only file in there is the stub, and the stub is stale by construction, because it stopped being
written the instant it parked.

Worse, `debug/session-divergence` — the monitor written specifically so a new handoff shape could
not run unreported — was silent for the whole 10 hours, for the same reason: it gathered its
evidence from the subtree, found exactly one id, saw that id in the chain, and agreed.

### The fix

The link the two processes share is a **pointer, not a topology**: the stub's file carries
`parkedJobId`, and the host's file carries the matching `jobId`. Nothing else connects them.

1. `resolveSessionState` picks the freshest sessions file in the subtree as before, then, if that
   file names a `parkedJobId`, follows it to the sessions file claiming that `jobId` (scanning
   `~/.claude/sessions/` — the host is by definition outside the tree). The pointer is
   authoritative: no mtime comparison, since a stale-by-construction stub would win one.
   Transitive, cycle-bounded, and it falls back to the stub's own id when the job has exited.
   The directory scan is paid only by panes that actually parked something.
2. `debug/session-divergence` widens the same way, independently (it still reads the files itself
   rather than calling the resolver it audits) — so if a *third* shape defeats hop-following, the
   monitor can still see the id and file the report.

### Scope check, again

Same measurement as the original: parking is rare (1 pane of 27 at the time of the incident), so
the hop is off the path for every ordinary pane, and the stub-only fallback keeps a parked-then-
exited job behaving exactly as it did before.
