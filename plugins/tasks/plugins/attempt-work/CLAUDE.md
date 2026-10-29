# attempt-work

One authority for a single question: **where does this attempt stand relative to
`main`?** The answer is measured from git — how far the attempt's branch is ahead
of `main`, plus which of `main`'s commits carry this attempt's conversation
trailers — and it is the fact every "is it safe to drop this?" decision reads.

It lives under `plugins/tasks/` rather than inside `commits-graph` (a chip-and-pane
plugin) because the server-side exit-drop guard needs it and because the standing
is a task-domain fact. Dependency direction: `tasks-core` ← `attempt-work` ←
{`commits-graph`, `push-and-exit`, `drop-and-exit`}. `tasks-core` never imports it,
so there is no cycle.

## Why not the `pushes` table

The `pushes` table was an **event ledger**, written by a `tasks.push-ingest` job
reacting to `git.refAdvanced`. When that job lagged — it was observed 40+ minutes
behind a wedged queue — the table was empty for work that is fully merged into
`main`. So `pushes.length === 0` conflated two different facts: *"nothing was
pushed"* and *"nothing has been ingested yet"*. Read as the former, it offered
**Drop & Close** over landed work, and `maybeDropTaskOnExit` actually performed the
drop.

That lag is now closed at the source: the ledger is a projection of `main`,
re-derived in-process on every ref advance and guaranteed on read (I5,
`tasks/tasks-core/CLAUDE.md`,
`research/2026-08-18-global-push-ledger-git-projection.md`). **This plugin still
does not read it as an authority**, and the reason is no longer freshness — it is
that the ledger answers a different question. It records what LANDED; the standing
also has to account for commits that have not been pushed yet (D2), which no row
in that table will ever describe. A complete ledger also still cannot see a commit
that carries no trailer. So I3 below stands unchanged.

Git has no such lag. Every commit that lands via `./equin push` carries
the conversation trailer (`<convId>`) and the push trailer (`<uuid>`), and the
pre-push `conversation-trailer` check *fails the push* when a commit lacks the
conversation trailer — so this is an enforced invariant, not a convention. `main`
is only ever fast-forwarded, so its history is a complete record of what landed.
Full design: `research/2026-08-17-global-attempt-work-git-derived-standing.md`.

## I3 — a ledger row is positive evidence only

`AttemptWork.ledgerPushes` is still read from `pushes`, and that is deliberate: a
row **proves** a push happened, which is what keeps a pre-trailer-era attempt (its
commits carry no trailer to grep for) from reading as droppable. But it may only
ever be **ORed into** a positive answer — see `standingOf` — and never used to
conclude a negative one. Its absence proves nothing at all.

Anything new that wants to know whether an attempt has work at stake reads
`getAttemptWork` / the `attemptWork` live value, not the ledger. What stays on the ledger
is everything that is *about one specific recorded push* (`task-events`,
`push-profiling`, the per-push diff, the review pane, the `pushes.landed` trigger)
— those are display-only or self-healing.

`attempts_v.status` also reads the ledger, and now holds the same discipline: I6
(`tasks-core/CLAUDE.md`) makes every arm a fact the row proves, so no status claims
"nothing landed" and none can contradict `standingOf`. The badge and this plugin's
buttons agree by construction rather than by coincidence.

## I4 — the standing is a discriminated value, not a count

`standingOf(work)` returns `"none" | "pending" | "landed"`, and it is the **only**
place any of these counts is compared to zero. Decision sites `switch` on the
result, exhaustively, so a new arm becomes a `tsc` error rather than a silently
mishandled case. There is no array at a decision site whose emptiness can be
misread, and the destructive branch is reachable only from a measured `"none"`.

`"pending"` wins over `"landed"`: unpushed commits are the actionable state, so an
attempt with both still asks for a push.

## `no-branch` is an answer, not a failure

`AttemptPending` has two arms. `measured` carries `ahead` / `behind` /
`mergeBase` / `branch`. `no-branch` means the branch ref does not exist — and that
is a **determinate** answer: with no ref, no unpushed commit of this attempt can
survive to be lost, so `standingOf` may safely treat it as "nothing pending". It is
not a stand-in for a read that failed.

Everything that could make the standing merely *unknown* is kept out of that arm:

- A **reaped worktree** is not `no-branch`. `git worktree remove` does not delete
  the branch, so `refs/heads/claude-web/<attemptId>` (from
  `attemptBranchName`, the one definition of the convention) is still measurable
  from the main repo — and `landed` was always measurable there. This is why the
  resource does *not* collapse a missing worktree onto `unresolved`, the way
  `commits-graph` does.
- A **real git failure throws**. `refExists` distinguishes a clean "no such ref"
  (`rev-parse --verify --quiet` exiting 1) from every other non-zero exit, and
  `readMergeBase` / `readDeltaCounts` / `readLanded` propagate. A throw aborts the
  memo recompute and retains the previous entry; it never manufactures `ahead: 0`
  or an empty landed set.
- **Genuinely unmeasurable** is the payload's `Resolvable` unresolved arm — an
  attempt row that no longer exists (no followed `attempt` row). Consumers route that to the non-destructive
  action, exactly as they already do for an errored or never-loaded resource.

## Shape

- `core/protocol.ts` — the wire payload (`AttemptWork`, wrapped in `Resolvable`).
- `core/standing.ts` — `standingOf`, the decision layer.
- The reader half of the trailer grammar (key names, the `git log --format=`
  fragment, `parseTrailerLog`) lives in `tasks-core/core`, with the `pushes` table
  it fills, and is imported from there — so the format string, its parse, and the
  ledger's own projection have one home. The writer half (the shell hook, the push
  CLI) keeps its literals, bound to these readers by the `conversation-trailer`
  check.
- `server/internal/measure.ts` — the git reads, deliberately **DB-free** so
  `measure.test.ts` can reproduce each behaviour against a throwaway repo with no
  database and no plugin runtime. `commits-graph` shares these helpers rather than
  keeping its own copies.
- `server/internal/work.ts` — the orchestration behind one `createSignedMemo`, so
  the resource's `revalidate` and its `loader` are provably the same authority
  over the same inputs (`research/2026-07-09-global-etag-value-coproduction.md`).
  The memo reads **no database**: its input is the attempt's `AttemptFacts` (the
  attempt row, its conversation ids, its ledger count, its delivery), and
  `contextFrom(attemptId, facts)` derives the measurement's context purely. Two
  producers of the facts: the live value's followed rows (`attemptFactsFrom`)
  and `readAttemptFacts` (the same facts by SQL) behind `getAttemptWork`, for the
  callers that are not a resource (the exit-drop guard, the outcome-report MCP
  tool). The signature folds in both tips, the conversation set (it grows while
  an attempt runs), the ledger count (a push row can land with no local ref
  moving) and the checkout path (the pending half reads the checkout's HEAD,
  or the branch ref once cleanup reaped it — a path moving with the tips
  unchanged must not hit an entry read from the other). The cached value IS the wire payload, so a hit hands the runtime the
  very object it last served and D8 sends nothing.
- **The landed memo** (`work.ts`, `landedShasFrom`) — the trailer grep alone,
  signed on `main`'s tip, the attempt's start and its sorted conversation set,
  keyed by attempt. attempt-work's measurement and commits-graph's pane both read
  it (each handing the facts its own follows read), so the chip's count and the
  pane's rows come from ONE grep. No "unmeasurable" arm: the facts it takes carry
  the attempt's start, so a caller holding them holds an attempt that exists.
- `machine/internal/resource.ts` — `attemptWorkServed`, a db-arm `serveValue` of
  `core`'s `attemptWork` that **follows** four collection tuples (tasks-core's
  follow targets): `attempt` (`attemptWorkspaces { ids }`), `convIds`
  (`attemptConversationIds { where }`), `pushIds` (`attemptPushIds { where }`),
  `delivery` (`attemptDeliveries { ids }`) — no whole-table `reads`, so a write
  reaches only the attempts whose facts it moves (a `viewed` write on a
  conversation, another attempt's write: nothing). The loader pulls the push
  ledger current first (`PushLedger.ensureFresh`, in its own `bg` span at
  tasks-core's provider, so the loader captures none of the reconcile); the rows
  were read before, so a reconcile inserting this attempt's pushes lands on the
  next load through the `pushIds` follow — one load of lag on a positive-only
  count (I3). Refreshed by `recomputeOn: [refHeadServed]` (every subscribed
  attempt) besides the follows. There is deliberately no `recomputeOn` edge from
  the pushes ledger's resources: now that the landed set is git-measured, a ref
  advance is the complete refresh signal. `whileSubscribed` only evicts the
  attempt's memos (by attempt id) when its last subscriber leaves — it reads no
  followed row, so it is not `whileFollowing` and a moved row never restarts it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The attempt-work authority: where an attempt stands relative to `main`, measured from git (branch counts + conversation trailers on main) rather than from the lagging pushes ledger — the direct read for the server-side exit-drop guard and the git measurements commits-graph shares. The live value is served by the machine half.
- Server:
  - Contributes: `resource.declare` "attempt-work"
  - Uses:
    - `infra/git/git-read-cache.createSignedMemo`
    - `infra/git/git-watcher.lastKnownMainSha`
    - `infra/host/host-read-pool.withHeavyReadSlot`
    - `infra/worktree.ensureMainWorktreeRoot`
    - `primitives/commit-list.GitError`
    - `primitives/commit-list.runGit`
    - `primitives/commit-list.tryRunGit`
    - `primitives/commit-list.WorktreeGoneError`
    - `tasks/tasks-core.getAttemptRow`
    - `tasks/tasks-core.hasAttemptDelivery`
    - `tasks/tasks-core.listConversationIdsForAttempt`
    - `tasks/tasks-core.listPushesForAttempt`
  - Exports (values):
    - `attemptWorkEtag`
    - `deltaEtag`
    - `evictLandedShas`
    - `getAttemptWork`
    - `landedShasFrom`
    - `probeHeadMain`
    - `probeRefMain`
    - `readBranch`
    - `readDeltaCounts`
    - `readLanded`
    - `readMergeBase`
    - `readPendingFromBranchRef`
    - `readPendingInWorktree`
    - `refExists`
  - Resources: `attempt-work` (push)
- Machine:
  - Uses: `network/live.serveValue`
- Core:
  - Uses:
    - `network/live.liveValue`
    - `primitives/live-state.resolvableSchema`
  - Exports (types):
    - `AttemptPending`
    - `AttemptWork`
    - `AttemptWorkPayload`
    - `Standing`
  - Exports (values):
    - `AttemptPendingSchema`
    - `attemptWork`
    - `AttemptWorkPayloadSchema`
    - `AttemptWorkSchema`
    - `standingOf`
- Cross-plugin:
  - Imported by: `conversations/conversation-view/drop-and-exit`

<!-- AUTOGENERATED:END -->
