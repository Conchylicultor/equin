# A pane's session is the one that claims it, not the freshest file underneath it

**Date:** 2026-08-19
**Category:** global (`conversations/runtime-tmux` + `conversations/transcript-watcher` +
`conversations/session-chain` + `debug/session-divergence` + one data migration)

## Context

On 2026-08-19 the conversation view for `conv-1786969506-7e03` showed two messages
its tmux pane never printed. They were real messages — belonging to
`conv-1787096859-nhi0`, a different agent in a different worktree.

The transcript is assembled from the session ids in the conversation's chain
(`conversation_sessions`). That chain had acquired a third, foreign id:

```
9fd24c8e   own      → ~/.claude/projects/…-att-1786969505-xoj5
baf9c302   own      → ~/.claude/projects/…-att-1786969505-xoj5      (the parked job — resolved correctly)
2bf76e71   FOREIGN  → ~/.claude/projects/…-att-1787096858-0t1l      (conv-1787096859-nhi0's)
```

Both conversations recorded `2bf76e71` within 0.5 s of each other, and it is
also sitting in `conversations.claude_session_id` for both.

### How the foreign id got in

`resolveSessionState` answers "which Claude session is this pane running?" by
walking every pid in the pane's process subtree, reading each one's
`~/.claude/sessions/<pid>.json`, and keeping the **freshest** record. The real
tree:

```
9948   claude --resume 9fd24c8e        ← the pane (conv-1786969506-7e03, worktree att-1786969505-xoj5)
└─ 27243  claude daemon run --origin transient      ← the machine-wide daemon, started by this pane
   └─ 27538  claude bg-pty-host (spare)
      └─ 27571  claude bg-spare        ← lent to conv-1787096859-nhi0
                sessionId 2bf76e71 · kind "bg" · tmux (unset) · cwd = att-1787096858-0t1l
```

Claude Code runs **one** background daemon per machine, parented under whichever
pane happened to start it. It keeps pre-warmed spares and lends them to *any*
conversation. So a foreign agent's process sits inside an unrelated pane's
subtree, and its session file — written hours after the pane's own idle file —
wins the freshness comparison.

The assumption that broke: **every process under this pane belongs to this
conversation.** True before a shared daemon existed; false now. The resolver
searches by *proximity* and treats the result as *ownership*.

This is the same rule the build-artifact work already wrote down
([`2026-08-07`](./2026-08-07-global-per-run-check-transcript-and-pointer-integrity.md)):
*an artifact must never be able to impersonate a run that did not write it.*

### Why it matters beyond the rendering glitch

Blast radius of one foreign chain entry, all live today:

- `rewindLastUserTurn` truncates `paths.at(-1)` — currently the **other
  conversation's live transcript**. The Stop button is a data-loss button.
- `claude --resume <claudeSessionId>` on resume / fork / hibernation-wake
  attaches to the other agent's session.
- The watcher's reverse index fans the foreign file's writes out to this
  conversation's subscribers.
- Retention `utimes` and backup `cp` touch and copy a stranger's transcript.
- Cost attribution is keyed by session id; two rows sharing one id collide and
  the true owner's spend disappears.
- The status badge was being driven by the borrowed spare's status, i.e. by
  another agent's state.

### Why nothing caught it

`debug/session-divergence` exists precisely to audit this resolver. Its predicate
is one-directional: it flags a session **reachable from the pane but missing from
the chain** — an omission. A wrong id that the resolver *adopted* is in the
chain, so `if (chainIds.has(sessionId)) continue;` skips it. Cross-talk
corruption is self-concealing to the only safety net we have. The monitor has
fired **zero times since it was written** (`reports` has no
`conversation-session-divergence` row).

### The constraint this fix must not violate

Two prior incidents had the *opposite* shape — the resolver **missed** the live
session and the transcript silently froze while the pane looked idle: 747 min in
July 2026, then 10 h 25 m on 2026-08-18 (see
[`2026-07-09-conversations-session-chain.md`](./2026-07-09-conversations-session-chain.md)
and its 2026-08-18 addendum). A stranger's messages appearing is *visible* and
was noticed within a day; a frozen transcript is invisible and cost 12 hours
twice. **Any fix that trades visible-wrong for silent-empty is a step backwards.**

This is what kills the obvious fix. Matching a record to a pane by its `tmux`
stamp alone would resolve all 28 live panes correctly today — but a
daemon-hosted process does not inherit `$TMUX_PANE`, which is why *every*
`kind: "bg"` record on the machine has no `tmux` field. A stamp-only rule can
never follow a relocation, so it re-opens both earlier incidents.

## The rule

> A session record **claims** a pane when it says so (`tmux`), or — when it
> cannot say so — when it is **local** to it (`cwd`) and is not a background
> host. The subtree is where we look; the claim is what we accept.

Two tiers, evaluated over the same subtree walk we already do:

| Tier | Predicate | Covers |
|---|---|---|
| **1 — identity** | `tmux` stamp's `%pane_id` equals this pane's | every CLI ≥ 2.1.233 |
| **2 — locality** (only when tier 1 is empty) | no `tmux` field **and** `kind !== "bg"` **and** `cwd === pane.worktreePath` | legacy CLIs (4 live panes today), and a relocated child that cannot stamp |

Everything else in the subtree belongs to somebody else. The borrowed spare
fails both — wrong `cwd` *and* `kind: "bg"` — so it is unspellable as a
candidate. Verified against all 28 live panes: the rule resolves every one, and
for `conv-1786969506-7e03` it produces `baf9c302` where today's code produces
the foreign id.

Match on `%pane_id` only. `session_name` and `window_id` are mutable
(`rename-session`, `break-pane`, `move-window`); `#{pane_id}` is not.

Background sessions stay reachable **only through the explicit
`parkedJobId` → `jobId` pointer**, which is authoritative and already
implemented. That is the whole reason tier 2 can exclude `kind: "bg"` without
losing the parked case.

## Work

### 1. Resolver — `runtime-tmux` (the root cause)

`plugins/conversations/plugins/runtime-tmux/server/internal/claude-session.ts`

- `resolveSessionState(pane: PaneRef, tree, deps)` where
  `PaneRef = { panePid, paneId, worktreePath }`. Replace `resolveSubtreeRecord`'s
  freshest-wins scan with: walk the subtree → parse **identity fields only**
  (`sessionId`, `tmux`, `cwd`, `kind`, `parkedJobId`, `jobId`) → partition by
  tier → `candidates = self.length ? self : local` → freshest wins, ties to later
  in BFS order (preserves the existing deepest-wins test) → validate `status` on
  the winner → `followParkedJob`.
- **Parse `status` only for the winner.** Today every subtree pid is fully
  parsed, so one `bg-spare` running a newer CLI with an unrecognised status
  throws and blanks the *hosting* pane. Latent bug, live now, free to fix here.
- Unparseable `tmux` stamp → **throw**. Format drift must never degrade to
  silence across the whole fleet.
- Unknown `kind` → report, do not throw. `kind` is a secondary filter; a throw
  there is a self-inflicted blackout.
- Nothing claims → `NULL_STATE` (never a throw — the poller then keeps the stored
  id, which is the recoverable state) **plus an anomaly report when the subtree
  did contain a session-bearing record**. That report is the alarm for every
  residual shape; a subtree with no session file at all stays silent, since that
  is just Claude not having written its file yet.
- Add `reportAnomaly` to `SessionFileDeps` (injectable, so tests assert it):
  `unclaimed-subtree-session`, `foreign-session-outranked` (a rejected record was
  fresher than the winner — a live counter of how often the old code would have
  been wrong), `cwd-mismatch` on the final post-hop record, `stale-job-host-file`.
- `findJobHost`: filter candidates to pids present in the snapshot and throw only
  on **≥2 live** claimants of one `jobId`. Without the liveness filter a single
  leaked file wedges a pane at `NULL_STATE` permanently.

`plugins/conversations/plugins/runtime-tmux/server/internal/process-tree.ts`
- `ProcessTree` gains `pids: Set<number>` (one line in `captureProcessTree`) — the
  liveness filter above.

`plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts`
- `listPanes` adds `#{pane_id}` to its `-F` string (~line 502) and to the returned
  record; the `resolveSessionState` call (~line 562) passes a `PaneRef`.
  `#{window_id}` is deliberately **not** added — mutable, buys nothing.
- Delete `resolveClaudeSessionId`: zero callers repo-wide, and it is the one
  signature that cannot supply a `PaneRef`.

### 2. Read path — one conversation, one project directory

`plugins/conversations/plugins/transcript-watcher/server/internal/anchor.ts` (new)

`resolveAnchoredChain(sessionIds)` resolves each id, lets the **first one that
resolves** anchor the conversation's `~/.claude/projects/<dir>/`, and partitions
the rest into `kept` / `foreign` by directory. All of a conversation's sessions
run in one worktree — `lifecycle.ts`'s fork guard requires a fork to match the
source attempt, so this is enforced, not merely conventional. Verified against
every multi-entry chain in the DB: the invariant holds for all of them, and the
one violation is exactly this incident.

Deliberately **not** derived from `attempts.worktree_path` + Claude's cwd→dirname
encoding. Nothing in the repo re-implements that encoding, and if Claude changed
it a re-derivation would resolve *nothing* — blanking every conversation —
where the anchor degrades to "resolve one fewer id".

`resolve-chain.ts` returns `kept.map(k => k.path)` and reports each `foreign`
entry. This is the guard that makes `rewindLastUserTurn`'s tail correct again.

All 8+ call sites of `resolveConversationTranscriptPaths` already treat a
shrinking array as legitimate (missing files are dropped today) — audited, none
break.

**Report:** new kind `conversation-foreign-session`, payload
`{ conversationId, foreignSessionId, reason: "directory-mismatch" | "shared-session-id",
foreignDir, anchorDir, otherConversationIds }`, fingerprinted per
`(conversation, session)`. Colocated in `transcript-watcher` (`core/` schema,
`server/internal/` kind, `web/` renderer), mirroring how `session-divergence`
colocates its own. In-process 5-min debounce in front of `recordReport` — this
path runs on every transcript read and every live push — and it must never throw
into the caller.

### 3. Write boundary — anchor the poller's adoption gate

`plugins/conversations/server/internal/poller.ts` (~line 189). Today the gate
only asks "does a transcript exist *somewhere*". Ask instead whether it exists in
this conversation's anchor directory; a null anchor (first session ever) accepts
and becomes the anchor. One extra `listSessionChain` read, and only on the rare
tick where a session id actually changes.

Defense-in-depth, explicitly **not** load-bearing — genuinely redundant if the
resolver fix is airtight. It refuses silently; the "corruption still standing"
signal belongs to the monitor, not to a 1 Hz loop.

### 4. Repair the existing rows — required, not cleanup

The column self-heals; **the chain does not.** Once the resolver returns
`baf9c302`, `sessionChanged` fires and `conversations.claude_session_id` is
patched back. But `recordSessionId`'s tail probe compares against the *foreign*
row (still the newest `seen_at`), falls through to the insert, and the insert
conflicts on the already-present `baf9c302` row — `ON CONFLICT DO NOTHING`, no
`seen_at` touched. **The foreign entry stays the chain tail forever.**

So: a guarded DML data migration
(`./equin build --custom-migration --migration-name repair_conv_1786969506_7e03_foreign_session`),
following the `20260710_…__backfill_conversation_session_chain.sql` precedent:

```sql
DELETE FROM "conversation_sessions"
WHERE "conversation_id" = 'conv-1786969506-7e03'
  AND "claude_session_id" = '2bf76e71-986e-4818-9dde-403eca397bfc';

UPDATE "conversations"
SET "claude_session_id" = 'baf9c302-68bf-49c6-9f6b-cd58a290b209'
WHERE "id" = 'conv-1786969506-7e03'
  AND "claude_session_id" = '2bf76e71-986e-4818-9dde-403eca397bfc';
```

Both statements are scoped to `conv-1786969506-7e03` alone, so
`conv-1787096859-nhi0`'s own (correct) rows for that session id are untouched;
both are idempotent and no-op on every other DB fork. The `UPDATE` is guarded on
the known-wrong value, so it is a no-op if the poller healed the column first.

`conversation_sessions` is documented append-only. This is a one-off incident
repair through the sanctioned data-migration path, which is what that path is
for — the append-only rule governs the application, not a migration.

### 5. Monitor — and one ship-blocker

`plugins/debug/plugins/session-divergence/`

**Ship-blocker.** Pane 9948's subtree still reaches `27571`. The moment the
resolver stops adopting that id, the monitor's predicate (absent from chain,
has a transcript, leads the tail) becomes true and stays true — it fires on the
daemon-hosting pane every 5 minutes, forever. An alarm that always fires is an
alarm that is off. **This must land in the same change as §1.**

- **Foreign-claim exclusion** in `reachableSessionIds`: drop a subtree link whose
  `tmux` names a *different* pane `listPanes` knows about, and admit `kind: "bg"`
  links only through the monitor's own `parkedJobId` hop. Note the asymmetry, and
  keep it: the resolver filters by *its own* claim, the detector by *somebody
  else's*. Everything merely unclaimed stays evidence — that is what keeps the
  monitor able to catch the shapes §1 deliberately refuses to guess at. Do **not**
  give the detector the resolver's inclusion predicate; the plugin's whole design
  rests on judging the same world independently.
- **Baseline** switches from `chain.at(-1)` to the last *anchored* entry. Today
  the tail is the foreign row, so the existing omission check is measuring lead
  against an unrelated worktree's mtime.
- **Commission detectors** (new `detect-commission.ts`, kept out of
  `detectDivergences` so the carefully-specified (a)/(b)/(c) omission contract
  stays intact):
  - *directory-mismatch* — a chain entry outside its conversation's anchor.
  - *shared-session-id* — one `claude_session_id` in two conversations' chains.
    Pure SQL, no process tree, works for hibernated conversations, and would have
    caught this incident with no filesystem assumption at all. New
    `listSharedClaudeSessionIds()` in `session-chain` (it owns the table).
- Both file the `conversation-foreign-session` kind from §2 — same condition, same
  "go remove this row" answer, two discovery routes. `SessionDivergencePayload`
  stays scoped to the omission case; forcing one schema to carry both buys nothing.

## Tests

`claude-session.test.ts` already injects `SessionFileDeps`; add a
`reportAnomaly` collector and a `paneOf(pid, "%1", "/wt")` helper.

1. Modern pane: the record stamping `%1` beats a fresher one stamping `%2`.
2. **The live incident**: subtree `[9948, 27243, 27538, 27571]`, spare fresher and
   unstamped → resolves via 9948's park hop, never `2bf76e71`.
3. Same, with `kind` removed from the spare → the `cwd` exclusion fires on its own.
4. Legacy pane, no stamp anywhere → the pane's own file wins (tier 2).
5. **Legacy relocation (July incident)**: `root→a→b→c`, root a stale unstamped
   tombstone, `c` fresh, unstamped, matching `cwd` → resolves `c`. Regression guard.
6. Forked launcher, no file at `panePid`, child stamps `%1` → resolves the child.
7. Same with no stamp but matching `cwd` → resolves the child.
8. A subtree record stamping another pane, and nothing else → `NULL_STATE` **plus**
   `unclaimed-subtree-session`. Asserts silent-empty is now loud.
9. Unparseable `tmux` value throws, message names the stamp.
10. A fresher rejected record emits `foreign-session-outranked`; the winner still returns.
11. A foreign subtree record with an unrecognised `status` does not throw for this pane.
12. `kind: "bg"` with matching `cwd` and no stamp is still rejected when a tier-1
    claimant exists.
13. Two **live** records sharing a `jobId` → throws, naming both pids.
14. One live + one dead sharing a `jobId` → resolves the live one +
    `stale-job-host-file`.
15. Park hop to a host with mismatching `cwd` → still followed (pointer is
    authoritative) but emits `cwd-mismatch`.
16. The existing parked-job suite, re-run under the new signature.
17. **Perf invariant preserved**: an unparked pane never calls `listSessionPids`.
18. No session file anywhere in the subtree → `NULL_STATE` and **zero** anomalies.

Plus: `anchor.test.ts` (anchor from first resolvable; later foreign dir
partitioned; nothing resolves → empty, no anchor — the historical chain
`conv-1783448623-h424` is exactly this case, all three files GC'd) and a
`detect-commission.test.ts` for both predicates.

## Verification

1. `./equin build` (background), then `./equin test plugins/conversations/plugins/runtime-tmux plugins/conversations/plugins/transcript-watcher plugins/debug/plugins/session-divergence`.
2. **Resolution, live**: with the app deployed, confirm via `query_db` that
   `conversations.claude_session_id` for `conv-1786969506-7e03` reads
   `baf9c302-…` and that no conversation shares a `claude_session_id` with
   another:
   `select claude_session_id, count(distinct conversation_id) from conversation_sessions group by 1 having count(distinct conversation_id) > 1` → zero rows.
3. **Rendering**: open `http://<worktree>.localhost:9000/agents/c/conv-1786969506-7e03`
   and confirm the transcript now ends at "Verified: 11 studies…" — the same place
   its tmux pane ends. `tmux capture-pane -p -t conv-1786969506-7e03:0.0 -S -50`
   is the reference.
4. **No regression on the other conversation**: `conv-1787096859-nhi0` must still
   render its own `2bf76e71` turns in full.
5. **The monitor is quiet**: after the change, `select * from reports where kind
   in ('conversation-session-divergence','conversation-foreign-session')` should
   hold no *standing* row for the daemon-hosting pane. A row appearing here for a
   pane we have not corrupted is the ship-blocker in §5 not being fixed.
6. **Fleet sanity**: all 28 live panes still resolve — compare
   `conversations.claude_session_id` against each pane's own
   `~/.claude/sessions/<pane_pid>.json` chain for a full pass.

## Not doing

- Deleting the subtree walk. It is the only channel that caught the July
  incident, the `ps` snapshot is already taken once per tick, and it is what
  makes the `foreign-session-outranked` evidence possible at all.
- Deriving the expected projects directory from `attempts.worktree_path` — see §2.
- A general chain-repair matcher. The 2026-07-09 design rejected one as "guesswork
  dressed as recovery"; that decision stands. Repair stays per-incident, and §5's
  commission detectors are what make an incident visible enough to repair.

## Immediate risk, before any of this lands

`conv-1786969506-7e03`'s stored session id points at another agent's **live**
transcript. Pressing **Stop** on that conversation truncates that file;
**Resume** or a fork attaches to that session. Best left alone until §4 runs.
