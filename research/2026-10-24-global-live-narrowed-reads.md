# Resources track [12] session 2: computed values read through collection tuples (`follows`, compiled into the reach)

Track: Network Layer › Resources (`block-f64cfc08-6ec6-4ef3-9122-f143cc24798e`), item [12].

Prior docs:
- `2026-10-19-global-live-compiled-narrowing.md`. Section C of that doc is **superseded by this doc**. Its sections A and B are session 1, on main as `c4afec6024`.
- `2026-10-22-global-live-bounds-independent-of-freshness.md`. That is [13], on main as `0e3c207c6a`. It lets paged values declare `reads`.

## Context

**The problem.** A value computed from a few rows declares whole-table `reads`, so any write to those tables recomputes every subscribed tuple.
- Session 1 measured 10 `viewed` writes on *other* conversations. Each of attempt-work, commits-graph and allow-files paid 10 loads plus 10 update frames; commits-graph alone shipped 137 KB.
- The transcript family is larger than planned. Its values declare no reads, but the desktop `TranscriptSource.signature` resolves the session chain from the DB inside the loader (`transcript-watcher/server/internal/resolve-chain.ts`). The drift guard (A8 / D5) then fails open, so every `conversations` or `conversation_sessions` write FULL-recomputes every subscribed tuple.
  - It is live on main: `reports` holds "route drift for jsonl-events.prompts … conversations" (123 hits) and "transcript-stats.usage.before … conversation_sessions" (1176 hits).

**The rule.** Per-row narrowing comes only from compiled queries. No hand-written row filter can be spelled.

**Choice made on 2026-10-24.** We use **compiled narrowed reads** instead of the planned S2 runtime "hold" edge.
- The design review found that S2 needed a socket-independent tracker, a held value maintained by the drains (a third copy of the keyed-delta merge), ack forwarding, cold reads that need `notBefore`, and a runtime-owned watch lifecycle. It also had open holes: the watermark rule (Rule B), a watch leak, and partial registration.
- The runtime can already narrow a whole-table reach route per tuple. `TupleUse.match` applies to `full` routes: `routing.ts` `routeTuple` runs the gate, then the key filter `route.rows ∧ use.match`, then `full`.
- So a follow compiles into the follower's own reach, plus a compiled reader. There is no new edge kind, and Rule B holds by construction because the reads run inside the follower's flight, after the watermark capture.

## Design

### 1. Spelling (`network/live`, every host)

```ts
serveValue(attemptWork, {
  source: "db",
  follows: (follow) => ({
    attempt: follow(attemptWorkspacesServed,      ({ attemptId }) => ({ ids: [attemptId] })),
    convIds: follow(attemptConversationIdsServed, ({ attemptId }) => ({ where: { attemptId } })),
    pushIds: follow(attemptPushIdsServed,         ({ attemptId }) => ({ where: { attemptId } })),
    delivery: follow(attemptDeliveriesServed,     ({ attemptId }) => ({ ids: [attemptId] })),
  }),
  recomputeOn: [refHeadServed],
  loader: (p, { followed }) => attemptWorkFrom(p, followed),
  revalidate: (p, { followed }) => attemptWorkSignature(p, followed),
  whileSubscribed: (p, { followed, notify }) => …,
});
```

**Targets.** A follow targets a served collection handle, never a core descriptor. The handle proves the collection is served on this host. Two arms are typed:
- `{ ids }`: the collection's `:rows` point set.
- `{ where }`: a scoped `all` (`all: { by }`, from session 1).

A window, `:groups`, `:count`, a param-less `all`, or a value has no overload, so it is a tsc error. The tuple function is typed from the follower's subject: its params, or the decoded question of a typed-query or paged value.

**What the follow gives.** `followed[name]` is `Row[]`, read fresh in the flight. `loader`, `revalidate`, `whileSubscribed`, and a paged value's `loader(q, range)` and `meta(q)` all receive `{ followed }`. So the ETag and the value come from one source (the etag/value co-production rule).

**`reads` and `follows`.**
- `reads` becomes optional when `follows` is present. It stays for non-followed tables, e.g. attempt-work's `outsideFeed` if any.
- A `reads.tables` entry that is also a table of a followed plan (after view/relation expansion) is refused. It would re-widen the narrowing.
  - The refusal runs at serve time when both plans are known.
  - For deferred plans it runs at deferred bind / `indexRelationReads`.

### 2. Compile (`infra/query-resource`, the only place a plan is minted)

The new `compiledFollowReach(served, tupleOf, label)` sits beside `compiledValueReach` (`server/internal/routes.ts`). It returns two things.

**(a) Routes, copied from the collection's own minted plan.**
- Each route keeps the collection's column gate (its `columns`, so a `viewed` write on a picked-out column skips) and maps `full`.
- Each carries a per-tuple `use.match`, built by the same loop the collection uses:
  - `{ ids }` → the pk column;
  - `{ where }` → the `by` columns (`scopeOf`, `compile-alias.ts`).
- A join's far side has no tuple-param column, so it becomes a gated `full` route with no match. Example: `conversationWorkspaces`' `attempts` side, gated on `{id, worktree_path, workspace}`. That is accepted: such writes happen about once per attempt.
- `moves` columns carry over, so a re-pointed `attempt_id` reaches both the old host and the new.

**(b) A compiled reader.** It is the collection's own SQL for that tuple: the point lookup or the scoped `all` query, through the served collection's existing server read (the one `handle-list-blocks.ts` uses since session 1). The follower's loader can therefore never read a different row set than its routes cover.

**A8 stays exact.**
- Each follow's routes are tagged `via: <name>` in the ReachPlan.
- The compiled reader runs in its own read-capture span, which the runtime's drift check judges against the `via` routes only.
- The follower's own captured reads are judged with the `via` routes excluded. So a hand-written query on `conversations` inside the loader is still drift, which throws under `strictRoutes`.
- Mechanism: the capture keys on the innermost entry (`runtime-profiler/core/recorder.ts` `recordReadTables` → `contextRuntime.current()`). The exact span kind is settled when this is implemented; tests pin the behaviour (§Tests).
- Fix as part of this: `recordLoaderReadSet` keeps the previous capture when a run reads nothing (`server-core/core/read-set.ts`). A pure follower would then be judged on stale reads, so record the empty set for guarded keys.

### 3. Runtime (`resource-runtime`): two small changes

**(R1) External keyed entries (paged values) accept narrowed full routes.**
- Today D31 says no route may reach an external window. So [13]'s paged `reads` are relation reads WHOLE (`compiledKeyedReads`): a write re-reads every subscribed page.
- Narrow D31: an external window accepts `full` reach routes with a per-question `use.match`. A match marks that question's live pages FULL through `drainMembershipFull`, the path drift-only routing already takes for keyed windows.
- This change is needed for jsonl-events (pages + meta), subagent-transcript and edited-files, which became paged in [13].

**(R2) `onReached(params)` hook, for re-pointing watches.**
- `whileSubscribed` depends on followed rows (a worktree path, a session chain). Today edited-files and allow-files return `() => {}` when no worktree exists yet, and never re-run (code-explorer's `rootWaiters` exists to route around that).
- The hook is called synchronously when routing delivers a change to a *tracked* tuple of the entry, outside any flight. It also fires in invalidate mode, where no load runs.
- `compile-value.ts` keeps one lifecycle record per tracked tuple, tagged with the tracking span:
  - on `onReached`, it re-reads `followed` through the compiled readers in a `bg` span;
  - if the follow signature moved and the span is unchanged, it stops the old start and starts again;
  - `onLastUnsubscribe` stops it;
  - untracked reads (HTTP, preload, `loadResourceByKey`) never start one.
- This extends `pairLifecycle` (`compile-value.ts`) and keeps "sync start stays sync" (allow-files).

**Messages.** The D32 and T15 refusal messages (`membershipUpstreamMessage`, `dbBackedUpstreamMessage`) and the `recomputeOn` refusals point to `follows`.

**`_debug`.** Each key gains `follows: [{name, collection}]` and the count of `onReached` re-points.

### 4. Follow-target collections (new unless noted)

Rule: a target's pick is exactly the follower's read-set. That is why the wide rows (`conversationsById`, `attemptRows`) are not reused: every column they carry would recompute the follower.

| Collection | Plugin (core + server) | Over | Form | Pick / gate |
|---|---|---|---|---|
| `attemptWorkspaces` (exists, extend) | tasks-core | `attempts` | lookup `:rows` | `id, workspace` + `worktreePath, createdAt`. Check C39 for the added fields. |
| `attemptConversationIds` | tasks-core | `conversations` | `all: { by: ["attemptId"] }`, order `createdAt` | `id, attemptId, createdAt` |
| `attemptPushIds` | tasks-core | `pushes` | `all: { by: ["attemptId"] }` | `id, attemptId, createdAt`. `pushRows` can't be reused: it is a window, so it has no per-tuple match. |
| `attemptDeliveries` | tasks-core | `attempt_deliveries` (pk `attempt_id`) | lookup | `attemptId` (`attemptDeliveriesEntityRef` exists) |
| `conversationWorkspaces` | tasks-core (workspace can't import tasks-core: cycle) | `conversations` + lookup join `attempt` (`conversationOwnerJoins`) | lookup | `id, attemptId` + joined `worktreePath`, `workspace`. Pin the jsonb `workspace` binding through a join in `serve-collection-joins.test.ts`. |
| `conversationSessions` | session-chain | `conversation_sessions` | `all: { by: ["conversationId"] }`, order `seenAt` | `id, conversationId, claudeSessionId, seenAt` |
| `conversationSessionTails` | tasks-core | `conversations` | lookup | `id, claudeSessionId` |
| `conversationRuntimes` (if the extras batch is taken) | tasks-core | `conversations` | lookup | `id, runtime, status` |

All are portable. Their truth is in the DB, and the tasks-core and session-chain server barrels are already portable.

### 5. Migration

**attempt-work** (`tasks/plugins/attempt-work`).
- Split `readContext` (`server/internal/work.ts`) into:
  - a pure `contextFrom(facts)`;
  - `readAttemptFacts` (the existing SQL), kept for the two non-resource callers (`drop-and-exit`, `outcome-report` MCP).
- `createSignedMemo` (`git-read-cache/server/internal/signed-memo.ts`) takes an input: `signature(key, input)` / `compute(key, input)`.
- Split the memo into a `landedMemo` (`{convIds, since}`) and the pending probe. commits-graph shares `landedMemo`, which keeps one trailer grep.
- **Ledger.** Today `listPushesForAttempt` pulls the ledger fresh (`PushLedger.ensureFresh`) inside the loader span. Instead:
  - wrap `ensurePushLedgerFresh` in its own `recordEntrySpan("bg", "push-ledger.reconcile")`, at the provider (`tasks-core/machine/index.ts`), so no caller's loader captures its reads or writes;
  - attempt-work calls `ensureFresh()` and then reads `followed.pushIds`.
- Convergence on a conversation insert into A takes at most 2 loads: an entrant in `convIds`, then the reconcile inserts pushes, then an entrant in `pushIds`, then a memo hit.
- Memoize the wire projection per memo value, so an unchanged recompute returns the same object and D8 sends nothing.

**commits-graph.graph.** It follows `attempt` and `convIds`, not attempt-work's value, because the wire payload drops `landedShas`. Its loader calls `landedShasFrom(attemptId, followed)`. Its `revalidate` ETag folds `convIds` + `worktreePath`. Without that, an adopted conversation leaves a stale 304.

**edited-files (paged), allow-files, review.plugin-changes.**
- Each follows `ws: conversationWorkspaces { ids: [id] }`.
- `findWorkspaceOfConversation` stays for non-resource callers only, with its comment updated to say so.
- The `whileSubscribed` re-point (R2) fixes a worktree that is checked out after the first subscribe.
- plugin-changes is `(excluded)` from the default composition, so it is optional in the measurement.

**Transcript family** (about 12 values).
- `TranscriptChain` facts plus a pure `transcriptChainOf(sessions, tail)` go in transcript-source core. That is the one place the `claude_session_id` fallback rule lives.
- `transcriptChainFollows` replaces `transcriptChainReads` (`transcript-source/server/internal/chain-reads.ts`) and is declared once in the wrappers:
  - `serveTranscriptValue` (`jsonl-viewer/server/internal/transcript-value.ts`): outline.turns, artifacts, task-tools, the shells / subagents served values;
  - `transcript-stats/server/internal/serve-fold.ts`;
  - the `jsonl-events` / `.tool-call` / `.prompts` trio (`jsonl-events-resource.ts`);
  - the three machine values (subagent-activity, subagent-transcript, background-shell-output).
- `TranscriptSourceImpl.signature(id, chain)` / `events(id, chain)`. The disk provider resolves chain → paths from the filesystem only, through the new `resolveTranscriptPathsOf`. `resolveConversationTranscriptPaths(id)` stays as DB facts + fs, for non-resource callers (rewind, backup, retention, the watcher). The memory provider ignores the chain.
- The watcher's own `watch` keeps resolving by itself, outside loader spans. `refreshConversationChain` already re-points it.
- Fix D8 here: give `serveTranscriptValue` a `revalidate` over the events signature. Without one, D8 never runs, so a same-value recompute ships a frame, which contradicts the wrapper's comment.

**Extras** (delegated, after the core migration lands).
- **code.file / code.file-diff** (`code-explorer/machine/internal/workspace.ts`, reads `_attempts`): follow `attemptWorkspaces`, then delete `rootWaiters`.
- **conversations.partial-message / context-usage** (`conversations/machine/internal/`): follow `conversationRuntimes`.
- Later pass, not this session: the active-data `attempt` / `conv` / `task-link` referents, task-source-url, task-subject.

## Execution

1. **Baseline first.**
   - Add the fixture endpoint `POST /api/debug/read-set/narrowing-fixture` in `debug/read-set/server`. It refuses on main and is reversible. Body actions: `create-conversation {attemptId}` through `insertConversation`, `record-session {conversationId}`, `move-conversation {conversationId, attemptId}`, `delete-conversation`. Never touch a real conversation's chain.
   - Extend `network/live/e2e/narrowing.ts`.
   - Build, then run the baseline on this unchanged-except-fixture build.
2. **Framework.** I do this myself:
   - the compile (§2) and the A8 `via` judging;
   - R1 and R2;
   - the `follows` spelling and types in compile-value / serve-value, wired in every host;
   - tests.
3. **Collections + migration.** A workflow of Sonnet/Opus agents on disjoint plugin sets, run sequentially where files overlap: (a) the tasks-core / session-chain collections, then in parallel (b) attempt-work + commits-graph, (c) the worktree trio, (d) the transcript family, (e) the extras.
4. **Verify.**
   - Run `./equin build` in the background.
   - Check `_debug`: every migrated key has `follows`, no whole-table route on the followed tables, and `routeDrifted = []`.
   - Run the after-measurement and `./equin check`.
   - Update the docs: CLAUDE.md for network/live, query-resource, resource-runtime and transcript-source; "As landed" here; the track header (session 1 and [13] are on main); the next-session task.

## Measurement (`plugins/network/plugins/live/e2e/narrowing.ts`)

**Setup.** Fixture conversation F in attempt A. Subscriptions:
- attempt-work and commits-graph for A and B;
- edited-files (page 0), allow-files and plugin-changes (if served) for C and F;
- for C and F: jsonl-events page 0, outline.turns, one transcript-stats fold, subagent-activity, background-shell-output, subagent-transcript;
- code.file for A (if the extras batch is taken).

**Unrelated phases.** Each is 10 writes, 300 ms apart, median of 3 runs. Pass = 0 loads, 0 feed, 0 update / invalidate / patch frames on every migrated key.
- `viewed` on other conversations;
- `viewed` on C itself;
- another task's title;
- a block on another page;
- `create-conversation` into B, with only A's values held;
- `record-session` on a conversation nobody holds.

**Related phases.**
1. `create-conversation` into A: attempt-work{A} and commits-graph{A} take 1–2 loads each. Record how many.
2. `record-session` on F: exactly 1 load per transcript value of F, and 0 for C.
3. `move-conversation` F A→B: edited-files, allow-files and plugin-changes{F} get 1 load each (or 1 invalidate), plus a visible watch re-point (the `_debug` re-point count). attempt-work and commits-graph for A and B get ≥1 load each.
4. `delete-conversation` F: cleanup, still measured.

**Report per key and phase:**
- Δ loads, `byParent` (push vs cascade), from `get_runtime_profile`;
- Δ `notifyStats.feed`;
- frames by kind and total characters;
- `routeDrifted`;
- `ackOverflows`.

The numbers go into "As landed" and the track page, before/after.

## Tests

- **query-resource `routes.test.ts`:**
  - a follow's routes equal the collection's routes, gate included, with the `ids` / `by` match;
  - the far side of a join is gated `full` with no match;
  - `moves` carry over;
  - the overlap refusal fires, directly and via a relation base.
- **query-resource `serve-value-follows` oracle** (real DB via `database/db-test-fixture`, like the `serve-collection-*-oracle` suites):
  - an unrelated write gives 0 loads;
  - a related write gives 1;
  - a re-pointed `attempt_id` reaches the old and the new tuple;
  - under `strictRoutes`, a loader that reads a followed table by hand throws;
  - a pure follower whose loader reads nothing is not judged on a stale capture.
- **resource-runtime:**
  - `runtime-external-window` (or `runtime-window-membership`): a narrowed full route on a paged entry marks only the matching question FULL (R1);
  - `runtime-on-reached.test.ts`: the hook fires for tracked tuples only, in push and invalidate modes, outside flights (R2).
- **network/live `compile-value.test.ts`:**
  - `followed` is passed to every hook;
  - the lifecycle restarts only when the signature moved and the span is unchanged; a stop before a start never leaks; untracked reads start nothing;
  - type cases: a window target and a wrong tuple shape are `@ts-expect-error`; `followed` is typed per name.
- **Owning plugins:** attempt-work `work` (facts path ≡ SQL path), `signed-memo` input, transcript-source `transcriptChainOf`, a disk-provider chain → paths test.

Run with `./equin test <those plugin paths>`, plus `./equin check`.

## Risks

- **The join far side is gated full.** A write to an attempt's `worktree_path` or `workspace` recomputes every conversation-workspace follower. Measured in phase 3. A dynamic match from the last read is a possible follow-up, if it shows.
- **One reader query per follow per load** (primary key or scoped). attempt-work runs about 8 queries per load today, and it would run 4.
- **The ledger's pushes count can lag one reconcile in a load.** It converges in one more load (I3: the count is positive-only evidence).
- **Bulk statements over the 7000-byte NOTIFY cap fall back to FULL.** That is sound, and it is counted.

## Baseline (2026-10-28, before)

Build `build-1793150190-lfuc86` of this branch at `1d55c1120a` (main as of 2026-10-28) plus the
fixture endpoint only — no framework or value change. Run in this worktree's deploy, against its
DB fork:

```bash
./equin run plugins/network/plugins/live/e2e/narrowing.ts \
  --page block-67619adf-3ee8-4be8-8360-a00689ce4ddd \
  --pages block-5340a17b-25ad-47b4-8ae1-664b15dc23f0,block-b0f20f9e-d244-4c71-9518-16e249c34283 \
  --other-page block-eae9ee6c-37f1-4c62-a851-73dd0347cda8 \
  --attempt att-1792535513-794zo3 --attempt-b att-1792418449-oqfkem \
  --conv conv-1792535513-cp9x2r \
  --others conv-1792020385-xu2x47,conv-1792107694-fs559l,conv-1792114150-9zpef9 \
  --other-task task-1792805572-5jsx2n --subagent agent:a51c29f836f2028d5 --runs 3
```

(defaults: `--writes 10 --gap-ms 300 --settle-ms 6000`; C has no background shell, so
`background-shell-output` is asked for a shell id no transcript holds — an `unknown-shell` tuple,
still loaded and routed.) A has a live checkout (`.claude/worktrees/att-1792535513-794zo3`) and C an
891 KB transcript with two sub-agents. `review.plugin-changes` is not served by the default
composition: not measured. Δloads and Δfeed are per KEY (both C's and F's tuples; A's and, from the
related phases on, B's), medians of 3 runs; `parents` and `frames` list each run's distinct value
(`label:kind×n`).

Reading it:

- **routeDrifted is empty everywhere.** Since `1008062c71` the transcript values declare the chain's
  reads (`transcriptChainReads`, whole `conversations` + `conversation_sessions`), so the drift
  reports in Context are gone — the cost is now a declared whole-table read, which is what this
  table measures.
- **Unrelated writes still cost every transcript tuple a load**: 10 `viewed` writes on other
  conversations = 14–20 loads per transcript key (C + F) and 7–10 for attempt-work /
  commits-graph{A}; a create into B or a record-session on an unheld fixture the same (the latter
  40 feed: two tables per write). `jsonl-events` and `subagent-transcript` ship a ~280-char keyed
  delta frame per load even when nothing changed (a paged page's empty delta); the other
  transcript values and attempt-work / commits-graph ship nothing (D8 / same value).
- **edited-files and allow-files already cost 0** on every unrelated write (compiled lookups gated on
  their columns) and 1 load each on move / delete of F.
- **Related**: create into A = 2 loads each for attempt-work / commits-graph (A only held) and 2 for
  every transcript key (C's too); record-session on F = 4 per transcript key (2 tables × C and F),
  the target is 1 for F and 0 for C.
- No `cascade` parent, no ack overflow anywhere.
- A 4 s settle (first trial) lost the move / delete phases' loads to the next read: the default is
  now 6 s.

| phase | key | Δloads | parents | Δfeed | frames | chars | ackOverflows | routeDrifted |
|---|---|---|---|---|---|---|---|---|
| block on another page | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | attempt-work | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | commits-graph.graph | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | jsonl-events | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | jsonl-events.prompts | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | jsonl-viewer.outline.turns | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | transcript-stats.usage.before | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | subagent-activity | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | background-shell-output | 0 |  | 0 |  | 0 | 0 |  |
| block on another page | subagent-transcript | 0 |  | 0 |  | 0 | 0 |  |
| viewed: other conversations | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| viewed: other conversations | attempt-work | 7 | push:7 / push:10 / push:6 | 10 |  | 0 | 0 |  |
| viewed: other conversations | commits-graph.graph | 7 | push:7 / push:10 / push:6 | 10 |  | 0 | 0 |  |
| viewed: other conversations | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| viewed: other conversations | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| viewed: other conversations | jsonl-events | 14 | push:14 / push:20 | 20 | C:delta×7 F:delta×7 / C:delta×10 F:delta×10 | 3950 | 0 |  |
| viewed: other conversations | jsonl-events.prompts | 14 | push:14 / push:20 | 20 |  | 0 | 0 |  |
| viewed: other conversations | jsonl-viewer.outline.turns | 14 | push:14 / push:20 | 20 |  | 0 | 0 |  |
| viewed: other conversations | transcript-stats.usage.before | 14 | push:14 / push:20 | 20 |  | 0 | 0 |  |
| viewed: other conversations | subagent-activity | 14 | push:14 / push:20 | 20 |  | 0 | 0 |  |
| viewed: other conversations | background-shell-output | 14 | push:14 / push:20 | 20 |  | 0 | 0 |  |
| viewed: other conversations | subagent-transcript | 14 | push:14 / push:20 | 20 | C:delta×7 F:delta×7 / C:delta×10 F:delta×10 | 4705 | 0 |  |
| viewed: C | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| viewed: C | attempt-work | 10 | push:10 / push:6 | 10 |  | 0 | 0 |  |
| viewed: C | commits-graph.graph | 10 | push:10 / push:6 | 10 |  | 0 | 0 |  |
| viewed: C | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| viewed: C | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| viewed: C | jsonl-events | 20 | push:20 / push:12 | 20 | C:delta×10 F:delta×10 / C:delta×6 F:delta×6 | 5555 | 0 |  |
| viewed: C | jsonl-events.prompts | 20 | push:20 / push:12 | 20 |  | 0 | 0 |  |
| viewed: C | jsonl-viewer.outline.turns | 20 | push:20 / push:12 | 20 |  | 0 | 0 |  |
| viewed: C | transcript-stats.usage.before | 20 | push:20 / push:12 | 20 |  | 0 | 0 |  |
| viewed: C | subagent-activity | 20 | push:20 / push:12 | 20 |  | 0 | 0 |  |
| viewed: C | background-shell-output | 20 | push:20 / push:12 | 20 |  | 0 | 0 |  |
| viewed: C | subagent-transcript | 20 | push:20 / push:12 | 20 | C:delta×10 F:delta×10 / C:delta×6 F:delta×6 | 6638 | 0 |  |
| another task's title | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | attempt-work | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | commits-graph.graph | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | jsonl-events | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | jsonl-events.prompts | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | jsonl-viewer.outline.turns | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | transcript-stats.usage.before | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | subagent-activity | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | background-shell-output | 0 |  | 0 |  | 0 | 0 |  |
| another task's title | subagent-transcript | 0 |  | 0 |  | 0 | 0 |  |
| create-conversation into B (B not held) | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| create-conversation into B (B not held) | attempt-work | 7 | push:7 / push:9 / push:4 | 10 |  | 0 | 0 |  |
| create-conversation into B (B not held) | commits-graph.graph | 7 | push:7 / push:9 / push:4 | 10 |  | 0 | 0 |  |
| create-conversation into B (B not held) | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| create-conversation into B (B not held) | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| create-conversation into B (B not held) | jsonl-events | 16 | push:16 / push:18 / push:10 | 20 | C:delta×8 F:delta×8 / C:delta×9 F:delta×9 / C:delta×5 F:delta×5 | 4487 | 0 |  |
| create-conversation into B (B not held) | jsonl-events.prompts | 16 | push:16 / push:18 / push:10 | 20 |  | 0 | 0 |  |
| create-conversation into B (B not held) | jsonl-viewer.outline.turns | 16 | push:16 / push:18 / push:10 | 20 |  | 0 | 0 |  |
| create-conversation into B (B not held) | transcript-stats.usage.before | 16 | push:16 / push:18 / push:10 | 20 |  | 0 | 0 |  |
| create-conversation into B (B not held) | subagent-activity | 16 | push:16 / push:18 / push:10 | 20 |  | 0 | 0 |  |
| create-conversation into B (B not held) | background-shell-output | 16 | push:16 / push:18 / push:10 | 20 |  | 0 | 0 |  |
| create-conversation into B (B not held) | subagent-transcript | 16 | push:16 / push:18 / push:10 | 20 | C:delta×8 F:delta×8 / C:delta×9 F:delta×9 / C:delta×5 F:delta×5 | 5349 | 0 |  |
| record-session: unheld fixture | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| record-session: unheld fixture | attempt-work | 10 | push:10 | 10 |  | 0 | 0 |  |
| record-session: unheld fixture | commits-graph.graph | 10 | push:10 | 10 |  | 0 | 0 |  |
| record-session: unheld fixture | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| record-session: unheld fixture | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| record-session: unheld fixture | jsonl-events | 36 | push:36 / push:40 / push:24 | 40 | C:delta×18 F:delta×18 / C:delta×20 F:delta×20 / C:delta×12 F:delta×12 | 10052 | 0 |  |
| record-session: unheld fixture | jsonl-events.prompts | 36 | push:36 / push:40 / push:24 | 40 |  | 0 | 0 |  |
| record-session: unheld fixture | jsonl-viewer.outline.turns | 36 | push:36 / push:40 / push:24 | 40 |  | 0 | 0 |  |
| record-session: unheld fixture | transcript-stats.usage.before | 36 | push:36 / push:40 / push:24 | 40 |  | 0 | 0 |  |
| record-session: unheld fixture | subagent-activity | 36 | push:36 / push:40 / push:24 | 40 |  | 0 | 0 |  |
| record-session: unheld fixture | background-shell-output | 36 | push:36 / push:40 / push:24 | 40 |  | 0 | 0 |  |
| record-session: unheld fixture | subagent-transcript | 36 | push:36 / push:40 / push:24 | 40 | C:delta×18 F:delta×18 / C:delta×20 F:delta×20 / C:delta×12 F:delta×12 | 11997 | 0 |  |
| block on the held page | page-blocks.v2 | 10 | push:10 | 10 | page:delta×10 | 6022 | 0 |  |
| block on the held page | attempt-work | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | commits-graph.graph | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | jsonl-events | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | jsonl-events.prompts | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | jsonl-viewer.outline.turns | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | transcript-stats.usage.before | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | subagent-activity | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | background-shell-output | 0 |  | 0 |  | 0 | 0 |  |
| block on the held page | subagent-transcript | 0 |  | 0 |  | 0 | 0 |  |
| create-conversation into A | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| create-conversation into A | attempt-work | 2 | push:2 | 2 |  | 0 | 0 |  |
| create-conversation into A | commits-graph.graph | 2 | push:2 | 2 |  | 0 | 0 |  |
| create-conversation into A | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| create-conversation into A | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| create-conversation into A | jsonl-events | 2 | push:2 | 2 | C:delta×1 F:delta×1 | 556 | 0 |  |
| create-conversation into A | jsonl-events.prompts | 2 | push:2 | 2 |  | 0 | 0 |  |
| create-conversation into A | jsonl-viewer.outline.turns | 2 | push:2 | 2 |  | 0 | 0 |  |
| create-conversation into A | transcript-stats.usage.before | 2 | push:2 | 2 |  | 0 | 0 |  |
| create-conversation into A | subagent-activity | 2 | push:2 | 2 |  | 0 | 0 |  |
| create-conversation into A | background-shell-output | 2 | push:2 | 2 |  | 0 | 0 |  |
| create-conversation into A | subagent-transcript | 2 | push:2 | 2 | C:delta×1 F:delta×1 | 664 | 0 |  |
| record-session: F | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| record-session: F | attempt-work | 2 | push:2 | 2 |  | 0 | 0 |  |
| record-session: F | commits-graph.graph | 2 | push:2 | 2 |  | 0 | 0 |  |
| record-session: F | edited-files | 0 |  | 0 |  | 0 | 0 |  |
| record-session: F | allow-files | 0 |  | 0 |  | 0 | 0 |  |
| record-session: F | jsonl-events | 4 | push:4 | 4 | C:delta×2 F:delta×2 | 1112 | 0 |  |
| record-session: F | jsonl-events.prompts | 4 | push:4 | 4 |  | 0 | 0 |  |
| record-session: F | jsonl-viewer.outline.turns | 4 | push:4 | 4 |  | 0 | 0 |  |
| record-session: F | transcript-stats.usage.before | 4 | push:4 | 4 |  | 0 | 0 |  |
| record-session: F | subagent-activity | 4 | push:4 | 4 |  | 0 | 0 |  |
| record-session: F | background-shell-output | 4 | push:4 | 4 |  | 0 | 0 |  |
| record-session: F | subagent-transcript | 4 | push:4 | 4 | C:delta×2 F:delta×2 | 1329 | 0 |  |
| move-conversation F A→B | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| move-conversation F A→B | attempt-work | 2 | push:2 | 2 |  | 0 | 0 |  |
| move-conversation F A→B | commits-graph.graph | 2 | push:2 | 2 |  | 0 | 0 |  |
| move-conversation F A→B | edited-files | 1 | push:1 | 1 | F:delta×1 | 689 | 0 |  |
| move-conversation F A→B | allow-files | 1 | push:1 | 1 |  | 0 | 0 |  |
| move-conversation F A→B | jsonl-events | 2 | push:2 | 2 | C:delta×1 F:delta×1 | 556 | 0 |  |
| move-conversation F A→B | jsonl-events.prompts | 2 | push:2 | 2 |  | 0 | 0 |  |
| move-conversation F A→B | jsonl-viewer.outline.turns | 2 | push:2 | 2 |  | 0 | 0 |  |
| move-conversation F A→B | transcript-stats.usage.before | 2 | push:2 | 2 |  | 0 | 0 |  |
| move-conversation F A→B | subagent-activity | 2 | push:2 | 2 |  | 0 | 0 |  |
| move-conversation F A→B | background-shell-output | 2 | push:2 | 2 |  | 0 | 0 |  |
| move-conversation F A→B | subagent-transcript | 2 | push:2 | 2 | C:delta×1 F:delta×1 | 664 | 0 |  |
| delete-conversation F | page-blocks.v2 | 0 |  | 0 |  | 0 | 0 |  |
| delete-conversation F | attempt-work | 2 | push:2 | 2 |  | 0 | 0 |  |
| delete-conversation F | commits-graph.graph | 2 | push:2 | 2 |  | 0 | 0 |  |
| delete-conversation F | edited-files | 1 | push:1 | 1 | F:delta×1 | 341 | 0 |  |
| delete-conversation F | allow-files | 1 | push:1 | 1 |  | 0 | 0 |  |
| delete-conversation F | jsonl-events | 2 | push:2 | 2 | C:delta×1 F:delta×1 | 555 | 0 |  |
| delete-conversation F | jsonl-events.prompts | 2 | push:2 | 2 |  | 0 | 0 |  |
| delete-conversation F | jsonl-viewer.outline.turns | 2 | push:2 | 2 |  | 0 | 0 |  |
| delete-conversation F | transcript-stats.usage.before | 2 | push:2 | 2 |  | 0 | 0 |  |
| delete-conversation F | subagent-activity | 2 | push:2 | 2 |  | 0 | 0 |  |
| delete-conversation F | background-shell-output | 2 | push:2 | 2 |  | 0 | 0 |  |
| delete-conversation F | subagent-transcript | 2 | push:2 | 2 | C:delta×1 F:delta×1 | 664 | 0 |  |

## After (2026-10-28)

Build `build-1793221766-1gqwkj` of this branch (every value of §5 on `follows`, `whileFollowing`
split from `whileSubscribed`), same worktree, same DB fork, EXACTLY the baseline command line
(`--runs 3`, medians; "ALL CHECKS PASSED", every run ran every phase, fixtures deleted).
`review.plugin-changes` is still not served by the default composition: not measured.

`_debug` on the deploy, after the run: every migrated key lists its `follows` (attempt-work 4,
commits-graph 2, edited-files / allow-files / edited-files.file 1, every transcript value
`chainSessions` + `chainTail`, code.file / code.file-diff / code.dir / code.resolve-file /
file-viewer.bytes `ws`, context-usage `conv`); none has an own route on `attempts`,
`conversations`, `pushes`, `attempt_deliveries` or `conversation_sessions` — only the `<follow>:base`
routes `followRead` copied; `routeDrifted` is `[]` on every follower and every follow target after
the loads, and each follower's own `readSet` is `[]` (its reads run in the targets' spans).
`followRepoints` after the run: edited-files 6, allow-files 6 (3 × move + 3 × delete of F),
subagent-activity / background-shell-output / subagent-transcript 9 (per run: 2 for record-session
— the tail write and the chain append each move a followed row — and 1 for delete), commits-graph 15 (every change to A's or B's conversation set — see below).

Rows where either side is non-zero (every other row is 0 → 0; no `cascade` parent, no ack overflow,
no route drift anywhere; the block on the held page is the unchanged control):

| phase | key | Δloads before → after | Δfeed before → after | frames after | chars before → after |
|---|---|---|---|---|---|
| viewed: other conversations | attempt-work | 7 → 0 | 10 → 0 |  | 0 → 0 |
| viewed: other conversations | commits-graph.graph | 7 → 0 | 10 → 0 |  | 0 → 0 |
| viewed: other conversations | jsonl-events | 14 → 0 | 20 → 0 |  | 3950 → 0 |
| viewed: other conversations | jsonl-events.prompts | 14 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: other conversations | jsonl-viewer.outline.turns | 14 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: other conversations | transcript-stats.usage.before | 14 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: other conversations | subagent-activity | 14 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: other conversations | background-shell-output | 14 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: other conversations | subagent-transcript | 14 → 0 | 20 → 0 |  | 4705 → 0 |
| viewed: C | attempt-work | 10 → 0 | 10 → 0 |  | 0 → 0 |
| viewed: C | commits-graph.graph | 10 → 0 | 10 → 0 |  | 0 → 0 |
| viewed: C | jsonl-events | 20 → 0 | 20 → 0 |  | 5555 → 0 |
| viewed: C | jsonl-events.prompts | 20 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: C | jsonl-viewer.outline.turns | 20 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: C | transcript-stats.usage.before | 20 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: C | subagent-activity | 20 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: C | background-shell-output | 20 → 0 | 20 → 0 |  | 0 → 0 |
| viewed: C | subagent-transcript | 20 → 0 | 20 → 0 |  | 6638 → 0 |
| create-conversation into B (B not held) | attempt-work | 7 → 0 | 10 → 0 |  | 0 → 0 |
| create-conversation into B (B not held) | commits-graph.graph | 7 → 0 | 10 → 0 |  | 0 → 0 |
| create-conversation into B (B not held) | jsonl-events | 16 → 0 | 20 → 0 |  | 4487 → 0 |
| create-conversation into B (B not held) | jsonl-events.prompts | 16 → 0 | 20 → 0 |  | 0 → 0 |
| create-conversation into B (B not held) | jsonl-viewer.outline.turns | 16 → 0 | 20 → 0 |  | 0 → 0 |
| create-conversation into B (B not held) | transcript-stats.usage.before | 16 → 0 | 20 → 0 |  | 0 → 0 |
| create-conversation into B (B not held) | subagent-activity | 16 → 0 | 20 → 0 |  | 0 → 0 |
| create-conversation into B (B not held) | background-shell-output | 16 → 0 | 20 → 0 |  | 0 → 0 |
| create-conversation into B (B not held) | subagent-transcript | 16 → 0 | 20 → 0 |  | 5349 → 0 |
| record-session: unheld fixture | attempt-work | 10 → 0 | 10 → 0 |  | 0 → 0 |
| record-session: unheld fixture | commits-graph.graph | 10 → 0 | 10 → 0 |  | 0 → 0 |
| record-session: unheld fixture | jsonl-events | 36 → 0 | 40 → 0 |  | 10052 → 0 |
| record-session: unheld fixture | jsonl-events.prompts | 36 → 0 | 40 → 0 |  | 0 → 0 |
| record-session: unheld fixture | jsonl-viewer.outline.turns | 36 → 0 | 40 → 0 |  | 0 → 0 |
| record-session: unheld fixture | transcript-stats.usage.before | 36 → 0 | 40 → 0 |  | 0 → 0 |
| record-session: unheld fixture | subagent-activity | 36 → 0 | 40 → 0 |  | 0 → 0 |
| record-session: unheld fixture | background-shell-output | 36 → 0 | 40 → 0 |  | 0 → 0 |
| record-session: unheld fixture | subagent-transcript | 36 → 0 | 40 → 0 |  | 11997 → 0 |
| block on the held page | page-blocks.v2 | 10 → 10 | 10 → 10 | page:delta×10 | 6022 → 6018 |
| create-conversation into A | attempt-work | 2 → 1 | 2 → 1 |  | 0 → 0 |
| create-conversation into A | commits-graph.graph | 2 → 1 | 2 → 1 |  | 0 → 0 |
| create-conversation into A | jsonl-events | 2 → 0 | 2 → 0 |  | 556 → 0 |
| create-conversation into A | jsonl-events.prompts | 2 → 0 | 2 → 0 |  | 0 → 0 |
| create-conversation into A | jsonl-viewer.outline.turns | 2 → 0 | 2 → 0 |  | 0 → 0 |
| create-conversation into A | transcript-stats.usage.before | 2 → 0 | 2 → 0 |  | 0 → 0 |
| create-conversation into A | subagent-activity | 2 → 0 | 2 → 0 |  | 0 → 0 |
| create-conversation into A | background-shell-output | 2 → 0 | 2 → 0 |  | 0 → 0 |
| create-conversation into A | subagent-transcript | 2 → 0 | 2 → 0 |  | 664 → 0 |
| record-session: F | attempt-work | 2 → 0 | 2 → 0 |  | 0 → 0 |
| record-session: F | commits-graph.graph | 2 → 0 | 2 → 0 |  | 0 → 0 |
| record-session: F | jsonl-events | 4 → 2 | 4 → 2 | F:delta×2 | 1112 → 552 |
| record-session: F | jsonl-events.prompts | 4 → 2 | 4 → 2 |  | 0 → 0 |
| record-session: F | jsonl-viewer.outline.turns | 4 → 2 | 4 → 2 |  | 0 → 0 |
| record-session: F | transcript-stats.usage.before | 4 → 2 | 4 → 2 |  | 0 → 0 |
| record-session: F | subagent-activity | 4 → 2 | 4 → 2 |  | 0 → 0 |
| record-session: F | background-shell-output | 4 → 2 | 4 → 2 |  | 0 → 0 |
| record-session: F | subagent-transcript | 4 → 2 | 4 → 2 | F:delta×2 | 1329 → 660 |
| move-conversation F A→B | attempt-work | 2 → 2 | 2 → 2 | B:update×1 A:update×1 / | 0 → 0 |
| move-conversation F A→B | commits-graph.graph | 2 → 2 | 2 → 2 | B:update×1 A:update×1 / | 0 → 0 |
| move-conversation F A→B | edited-files | 1 → 2 | 1 → 1 | F:delta×2 | 689 → 946 |
| move-conversation F A→B | allow-files | 1 → 2 | 1 → 1 |  | 0 → 0 |
| move-conversation F A→B | jsonl-events | 2 → 0 | 2 → 0 |  | 556 → 0 |
| move-conversation F A→B | jsonl-events.prompts | 2 → 0 | 2 → 0 |  | 0 → 0 |
| move-conversation F A→B | jsonl-viewer.outline.turns | 2 → 0 | 2 → 0 |  | 0 → 0 |
| move-conversation F A→B | transcript-stats.usage.before | 2 → 0 | 2 → 0 |  | 0 → 0 |
| move-conversation F A→B | subagent-activity | 2 → 0 | 2 → 0 |  | 0 → 0 |
| move-conversation F A→B | background-shell-output | 2 → 0 | 2 → 0 |  | 0 → 0 |
| move-conversation F A→B | subagent-transcript | 2 → 0 | 2 → 0 |  | 664 → 0 |
| delete-conversation F | attempt-work | 2 → 1 | 2 → 1 |  | 0 → 0 |
| delete-conversation F | commits-graph.graph | 2 → 1 | 2 → 1 |  | 0 → 0 |
| delete-conversation F | edited-files | 1 → 1 | 1 → 1 | F:delta×1 | 341 → 341 |
| delete-conversation F | allow-files | 1 → 1 | 1 → 1 |  | 0 → 0 |
| delete-conversation F | jsonl-events | 2 → 1 | 2 → 1 | F:delta×1 | 555 → 276 |
| delete-conversation F | jsonl-events.prompts | 2 → 1 | 2 → 1 |  | 0 → 0 |
| delete-conversation F | jsonl-viewer.outline.turns | 2 → 1 | 2 → 1 |  | 0 → 0 |
| delete-conversation F | transcript-stats.usage.before | 2 → 1 | 2 → 1 |  | 0 → 0 |
| delete-conversation F | subagent-activity | 2 → 1 | 2 → 1 |  | 0 → 0 |
| delete-conversation F | background-shell-output | 2 → 1 | 2 → 1 |  | 0 → 0 |
| delete-conversation F | subagent-transcript | 2 → 1 | 2 → 1 | F:delta×1 | 664 → 330 |

### Against the criteria

- **Unrelated phases — PASS.** 0 loads, 0 feed, 0 frames on every migrated key in all six
  (`viewed` on other conversations and on C, another task's title, a block on another page, a create
  into B with only A held, a record-session nobody holds) — was 7–36 loads and up to 12 KB of empty
  keyed deltas per key and phase.
- **Create into A — PASS.** attempt-work{A} and commits-graph{A} 1 load each (was 2); the
  transcript values 0 (was 2 — C's and F's tuples re-read for a write to neither chain).
- **Record-session on F — C: PASS (0), F: 2 loads, not 1.** Only F's tuples load (frames `F:` only;
  was 4 = 2 tables × C and F). The 2 are one per committed write: the fixture, like the reconciler's
  adoption (`status-reconciler.ts`), writes the tail (`conversations.claude_session_id`, reaching
  `chainTail`) and appends the chain (`conversation_sessions`, reaching `chainSessions`) in two
  implicit transactions, so two change-feed bursts, two drains. Both writes really move F's chain
  inputs; one load needs the adoption to commit both in ONE transaction (one NOTIFY burst — the
  feed routes a burst into one pending). A decision on the reconciler's transaction boundary
  (`updateConversation` takes no executor; the chain's `seenAt` ordering note assumes one append per
  transaction, which one tail + one append keeps) — left open.
- **Move F A→B — PASS, one extra load on the re-pointed watches.** attempt-work and commits-graph
  get 1 load on each of A and B (`A:update B:update`); edited-files and allow-files{F} 1 routed load
  (Δfeed 1) plus a visible re-point (`followRepoints`) whose restarted watch notifies once open — the
  second load. That notify is what makes the re-point sound (a change between the routed drain's
  read and the new watch opening would otherwise be missed); dropping it would need the runtime to
  route the change only after the re-point settled. The transcript values cost 0 (was 2).
- **Delete F — PASS.** 1 load for F's tuple per key (its `conversation-session-tails` row is gone;
  was 2, C included), attempt-work / commits-graph{A} 1 (was 2).

### Left from the measurement

- **Record-session on F costs 2 loads, not 1** (above): one per committed write. Needs the
  reconciler's adoption to commit the tail write and the chain append in one transaction — a
  decision on its transaction boundary, left open.
- **The re-pointed watch's own notify** (move F: 2 loads on edited-files / allow-files) stays: it
  is what makes a re-point sound.

### Review fixes (2026-10-29)

Three reviews (soundness, lifecycle, design) of the stage above; each finding re-verified against
the code, then:

- **`whileFollowing: { over, start }`** (design 1, medium — the API decision the measurement left
  open). `over(followed)` reads, sync, what the start runs over (a JSON value — the re-point
  signature), and `start(subject, { over[, notify] })` is handed THAT, never the rows: a start
  cannot depend on a row it does not sign (tsc: its context has no `followed`; the overloads infer
  `W` from `over` like `F` from `follows`). commits-graph signs the attempt's path alone, the
  transcript watches the derived chain (`followedTranscriptChain`), the worktree trio the path,
  code-explorer / file-viewer the `ws` rows. Chosen over `{ of: [names] }`: naming follows would
  not fix the transcript case (both follows are read; only the derived chain decides).
- **A failed (re)start is retried** (lifecycle 1, medium): it forgets its signature (only while it
  is the latest start), so the next reach re-starts it whether or not the rows moved.
- **A throwing `whileSubscribed` stop never leaks the follow start** (lifecycle 2): `try/finally`
  in `bothLifecycles`.
- **Reaches join a queued re-point** (lifecycle 4): a reach landing while one is queued and not
  yet reading joins it (answered `"unchanged"`, the queued caller answering for it), so a paged
  value's K pages + meta re-read once.
- **The drift guard judges each run on its OWN capture** (soundness 1): `wrapLoad` takes a
  `RunCapture` the host calls as the loader span closes (runtime-profiler's `recordEntrySpan`
  `onReads`); `lastReadSet` is read only for a host that hands none (a test harness) and by the L2
  persist seam (param-less entries).
- **A `{ ids }` follow is held to the identity's canonical text** (soundness 2): `paramsOf`
  refuses an id the column's `::text` cannot equal (the read and the routing alike), and
  `followRead` refuses an identity type with no one spelling (a timestamp) — `canonicalTextOf`
  moved out of `compile-alias.ts` into `canonical-text.ts`, shared with `scopeOf`.
- **attempt-work's memo signature folds in the checkout path** (soundness 3).
- **`RoutingRecord.via` keeps every follow per table** (design 2); the drift and relation
  refusals name them all.
- **Docs** (design 3): `revalidate` and the loader read the same source, each its own read.
- **One reading of a followed `conversationWorkspaces` row** (design 4): tasks-core core's
  `conversationWorkspaceOf(rows)` — edited-files, allow-files and plugin-changes.
- **Rejected — lifecycle 3** (a throwing async stop is an unhandled rejection): it is reported,
  not lost — the reports engine's `process.on("unhandledRejection")` files it — and the same
  pattern is `pairLifecycle`'s on main.

**Re-measured** (build `build-1793227994-slmnst`, EXACTLY the baseline command line, `--runs 3`:
"ALL CHECKS PASSED", every run ran every phase). Every Δloads / Δfeed / frames cell is the table
above, unchanged (no route moved). `followRepoints` after the run: commits-graph **0** (was 15 —
no attempt path moved), subagent-activity / background-shell-output / subagent-transcript **3**
(was 9 — delete only; record-session's chain append and tail write re-point nothing now: the
derived chain did not move), edited-files / allow-files 6 (unchanged: move + delete really move
F's path). `routeDrifted` `[]` and own `readSet` `[]` on every follower.

## As landed — session 2 (2026-10-29, worktree `att-1792806386-uq413x`, in review)

**What a value says now.** A value computed from a few rows declares `follows` instead of
whole-table `reads`: `follows: (follow) => ({ name: follow(servedCollection, (p) => ({ ids }) |
({ where })) })`. `followRead` (query-resource) copies the collection's own compiled routes into
the value's reach — column gate kept, per-tuple match from the same loop as the collection's SQL —
and the value's loader / `revalidate` / paged `loader` + `meta` get `{ followed }`, each followed
tuple read fresh through `loadResourceFresh` in the collection's own loader span (so the
collection's drift guard judges it, and the follower's own capture never covers a followed table:
a hand-written read of one is drift). A watch over followed rows is `whileFollowing: { over, start }`
(re-pointed when `over(followed)` moves, by the runtime's `onFollowReached`); `whileSubscribed`
stays for watches that need no row. Narrowed routes on paged values needed no runtime change (on
main since `0668b28737`).

**Follow targets** (all portable): `attemptWorkspaces` (grown), `attemptConversationIds`,
`attemptPushIds`, `attemptDeliveries`, `conversationWorkspaces`, `conversationSessionTails`,
`conversationRuntimes` (tasks-core), `conversationSessions` (session-chain).

**Migrated (28 keys):** attempt-work, commits-graph.graph, edited-files (+ `.file`), allow-files,
review.plugin-changes, every transcript value (jsonl-events pages/meta/tool-call/prompts,
`serveTranscriptValue`'s values, transcript-stats folds, subagent-activity / -transcript,
background-shell-output — the chain via `transcriptChainOf` in transcript-source core),
code.file / file-diff / dir / resolve-file, file-viewer.bytes, context-usage. Not migrated:
`conversations.partial-message` (a follow would add a query on every streamed flush).

**Deleted:** `transcriptChainReads`, `packages/parked-watch`, code-explorer's `rootWaiters`,
`readLandedShas`, tasks-core `workspaceOfConversationLookup`, the whole-table reasons of the
migrated values.

**Measured** (§Baseline / §After, same command line, medians of 3): every unrelated phase 7–36
loads per key → **0 loads, 0 frames** on every migrated key; create into A 2 → 1; record-session
on F 4 → 2 (C 0); delete F 2 → 1 (F only). `routeDrifted` `[]` everywhere.

**Open:** record-session costs 2 loads (adoption commits tail + chain append separately — the
reconciler's transaction boundary); `review.plugin-changes` and follows on the PGlite browser host
are untested; order-dependent test failures from server-core's `clearHostServices()` (13 tests,
pre-existing); throttle tests flaky under host load.

### After rebase (2026-10-29)

Rebased onto main `46fbbf201d` (zod 4, CLAUDE.md compaction, predicted endpoint effects, entity
`presentationReads`, `code.workspace-root`). `code.workspace-root` now follows `attemptWorkspaces`.
Main's `presentationReads` made every collection `from: conversationsEntityRef` carry title / kind /
timestamps — the follow targets too, so a retitle reached every follower (caught by
`follow-targets-oracle`). Fixed at the derivation: presentation reads ride a row only when the
collection `pick`s a field of its entity (`PresentedReads`, `live-fields.ts`); a carry-only
collection carries exactly what it names. Re-measured on `build-1793313044-ji1jf3`, EXACTLY the
baseline command line (`--runs 3`, "ALL CHECKS PASSED"): every cell equals the After table above.
