# An attempt's standing comes from git, not from the pushes ledger

Date: 2026-08-17
Category: global (tasks/attempt-work (new), tasks/tasks-core, tasks (push-watcher),
conversations/conversation-view/{push-and-exit, drop-and-exit, commits-graph})

Follow-up to `research/2026-07-09-global-resource-unknown-value-and-error-gate.md`
(this is the same class of bug on the one input that doc left alone) and
`research/2026-07-08-global-absorbable-failure-guardrail.md`.

## Context

On `main`, a conversation whose branch has already been merged into `main` offers
**Drop & Close** as its primary button — the destructive action, presented as fact.
Reproduced live: conversation `conv-1786971113-c3yy` landed `8362d52e1` into `main`,
and `main`'s UI showed *Drop & Close*, no pushes in the review pane, and a commits
chip with no push count.

The cause is the last two lines of `deriveExitMode`
(`push-and-exit/web/components/exit-mode.ts:90-92`): an **empty `pushes` array** is
read as positive proof that the attempt pushed nothing, and falls through to
`drop-and-exit`. But `pushes` is a lagging derived ledger. Rows are written by the
`tasks.push-ingest` job (`plugins/tasks/server/internal/push-watcher.ts`) reacting to
`git.refAdvanced`; when that job has not run — it had been stalled 40+ minutes behind a
wedged queue — the table is empty for work that is fully merged. *"No rows ingested
yet"* and *"nothing was pushed"* are the same value, and the code cannot tell them
apart.

The function is otherwise careful about exactly this: an errored resource, a
never-loaded one and an unresolvable edited-file set all route to the non-destructive
**Close (state unknown)**. `pushes` slipped through because emptiness *looks* like a
legitimate success value rather than an absence of knowledge.

### There are two independent defects on that line

- **D1 — a landed attempt reads as droppable.** The ledger lags; `[]` means unknown.
- **D2 — a committed-but-never-pushed attempt reads as droppable.** Its worktree is
  clean (so `files.value.length === 0`) and it has no push rows, so real commits on the
  branch are offered *Drop & Close*.

### Five surfaces, one lagging table

The brief named three. There are five, and the one it did not name is the most
dangerous because it is the actual destructive **write**:

| # | Surface | Reads | Consequence of an empty ledger |
| --- | --- | --- | --- |
| 1 | `deriveExitMode` (primary button) | `pushesByAttemptResource` | Destructive *Drop & Close* over landed work |
| 2 | `drop-and-exit-button.tsx` (exit-menu item) | same | Labels itself destructive *Drop & Close* instead of *Complete & Close* |
| 3 | **`maybeDropTaskOnExit`** (`tasks-core/.../mutations/cross-table.ts:24`) | `listPushesForAttempt` | **Actually sets `task.dropped`.** Reached by the manual endpoint *and* by the agent's own `exit_clean` → `exit-clean-finalize-job` — so an agent that pushes and exits cleanly gets its task dropped, with no UI involved |
| 4 | `commits-chip.tsx:45` | `pushesByAttemptResource` | Push count under-reports (shows nothing) |
| 5 | `computeGraph`'s `landedCommits` | `listPushesForAttempt` | The pane shows no landed commits |

### Why the fact is recoverable without the ledger

- Every commit that lands via `./equin push` carries
  `Singularity-Conversation: <convId>` (written by `.githooks/prepare-commit-msg` from
  `SINGULARITY_CONVERSATION_ID`) and `Singularity-Push: <uuid>` (stamped per push
  invocation by the rebase `--exec` in `cli/bin/commands/push.ts`). The pre-push
  `conversation-trailer` check **fails the push** when any commit in `main..HEAD` lacks
  the conversation trailer, so this is an enforced invariant, not a convention.
  Verified on the reproduction commit: `8362d52e1` carries both trailers.
- `main` is only ever fast-forwarded (`git log` confirms single-parent history), so the
  main repo's history is a complete, non-lagging record of what landed.
- Commits **ahead** of `main` on the attempt's branch are, by construction, that
  attempt's own unpushed work: `setupWorktree` creates the branch from `main`
  (`git worktree add -b claude-web/<attemptId> <wt> main`) and `push` only ever rebases
  it back onto `main`.
- `git worktree remove` does **not** delete the branch, so `refs/heads/claude-web/<id>`
  survives a reaped worktree — the branch is still measurable from the main repo.
- Cost is negligible: a full trailer-bearing `git log` over `main`'s 3565 commits takes
  143 ms; bounded to the attempt's lifetime it is ~50 ms, memoised on `(headSha,
  mainSha)` and gated by the existing heavy-read slot.

### The invariants to make structural

> **I3.** The fact "does this attempt have work at stake?" is measured from **git**.
> The `pushes` table is an event ledger: a row **proves** a push happened; its absence
> proves nothing. It may only ever be ORed *into* a positive answer, never used to
> conclude a negative one.
>
> **I4.** A decision-grade standing is a **discriminated value**, not a count a consumer
> compares to zero. `pushes.length === 0` must have no spelling at the decision site.

## Design

### 1. New plugin: `plugins/tasks/plugins/attempt-work/`

One attempt-scoped authority for *"where does this attempt stand relative to `main`?"*.
It lives under `plugins/tasks/` (not inside `commits-graph`, a chip-and-pane plugin)
because the server-side drop guard needs it and because the fact is a task-domain fact.

Dependency direction: `tasks-core` ← `attempt-work` ← {`commits-graph`,
`push-and-exit`, `drop-and-exit`}. No cycle — `tasks-core` never imports it.

**`core/protocol.ts`** — the wire payload. Every arm is a measured fact; the
unmeasurable case is the `Resolvable` unresolved arm, exactly as `edited-files` does it.

```ts
export const AttemptPendingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("measured"),
    ahead: z.number().int().nonnegative(),   // commits main does not contain
    behind: z.number().int().nonnegative(),
    branch: z.string().nullable(),
    mergeBase: z.string().nullable(),
  }),
  // The branch ref no longer exists, so no unpushed commit of this attempt can
  // survive to be lost. A DETERMINATE answer — a failed git read THROWS instead.
  z.object({ kind: z.literal("no-branch") }),
]);

export const AttemptWorkSchema = z.object({
  pending: AttemptPendingSchema,
  /** This attempt's commits `main` already contains, found by their
   *  Singularity-Conversation trailers. Git-measured; cannot lag. */
  landedCommits: z.number().int().nonnegative(),
  /** Distinct Singularity-Push trailer values among them — the true push count. */
  landedPushes: z.number().int().nonnegative(),
  /** Corroborating ledger evidence (I3). A row PROVES a push; its absence proves
   *  nothing. Only ORed into "landed", never used to conclude "nothing landed" —
   *  this is what keeps pre-trailer-era attempts from reading as droppable. */
  ledgerPushes: z.number().int().nonnegative(),
});

export const AttemptWorkPayloadSchema = resolvableSchema(AttemptWorkSchema);
export type AttemptWork = z.infer<typeof AttemptWorkSchema>;
```

**`core/standing.ts`** — the decision layer (I4). The only place a count is compared to
zero, with the reasoning written down once:

```ts
export type Standing = "none" | "pending" | "landed";

/** `pending` wins over `landed`: unpushed commits are the actionable state. */
export function standingOf(w: AttemptWork): Standing {
  if (w.pending.kind === "measured" && w.pending.ahead > 0) return "pending";
  if (w.landedCommits > 0 || w.ledgerPushes > 0) return "landed";
  return "none";
}
```

**`core/resources.ts`** — `attemptWorkResource = resourceDescriptor<AttemptWorkPayload,
{ attemptId: string }>("attempt-work", AttemptWorkPayloadSchema, unresolved("not
loaded"))`.

**`core/trailers.ts`** — the *reader* half of the trailer grammar, moved out of
`push-watcher.ts` so the format string and its parse have one home instead of two
copies: the `%(trailers:key=…)` log-format fragment, the two key names, and
`parseTrailerLog(raw): TrailerCommit[]`. `push-watcher.ts` imports them from here
(`plugins/tasks/server` → `plugins/tasks/plugins/attempt-work/core` is a legal child
barrel import). The *writer* half (the shell hook and the CLI) keeps its literals,
already bound to the readers by the `conversation-trailer` check.

**`server/internal/measure.ts`** — the git reads.

- `readLanded(mainRepoRoot, convIds, since)` — one
  `git log --no-color --since=<since> --format=<trailer format> refs/heads/main`, records
  filtered in JS to those whose conversation trailer is in `convIds`. Returns
  `{ shas, pushIds }`. `since` = `attempt.createdAt - 1h` (a commit cannot predate the
  attempt that authored it; the pad absorbs clock adjustment). Runs against
  `ensureMainWorktreeRoot()`, so it answers even for a reaped worktree.
- `readPending(attemptId)` — `rev-list --left-right --count main...HEAD` in
  `attempt.worktreePath` (lifted verbatim from `commits-graph`'s `computeDeltaCore`),
  falling back to `main...refs/heads/<attemptBranchName(attemptId)>` in the main repo
  when the worktree is gone, and to `{ kind: "no-branch" }` when the ref is gone too.
  Every other git failure throws.
- Both wrapped in one `withHeavyReadSlot`, behind one
  `createSignedMemo({ name: "attempt-work", … })` keyed by `attemptId`, whose signature
  is `${headSha}|${mainSha}|${convIdsKey}` (the conversation set can grow, so it is
  folded in; the existing graph `revalidate` already does a DB read, so this is no new
  cost class). `signature` and `compute` are bound at construction, so `revalidate` and
  `loader` cannot drift (`research/2026-07-09-global-etag-value-coproduction.md`).

`attemptBranchName(attemptId)` moves into `infra/worktree`'s barrel and `setupWorktree`
uses it, so the `claude-web/<id>` convention has exactly one definition.

**`server/internal/resource.ts`** — `attemptWorkResource`, `mode: "push"`,
`dependsOn: [{ resource: refHeadResource, map: <active attempts> }]` with the same
`onFirstSubscribe` / `onLastUnsubscribe` active-attempt tracking `commits-graph` uses
today. A `main` or branch advance is the *complete* refresh signal now that the landed
set is git-derived — the `pushesResource` dependency disappears.

**`server/index.ts` also exports**, for consumers that need the fact outside a
subscription:

- `getAttemptWork(attemptId): Promise<Resolvable<AttemptWork>>` — the same memo read.
- `readLandedShas(attemptId): Promise<string[]>` — for `commits-graph`'s pane rows.

### 2. `deriveExitMode` — the mistake loses its spelling

`pushes` leaves `ExitModeInput` entirely; `work` replaces it as a `Resolvable`:

```ts
if (!files.resolved) return { mode: "exit-error", provisional: false };
if (files.value.length > 0) {
  if (files.value.every((f) => f.path.startsWith("research/"))) return { mode: "go", … };
  return { mode: "push-and-exit", … };
}
// Uncommitted edits already decided it above, so an unmeasurable standing only
// degrades the cases that actually depend on it.
if (!work.resolved) return { mode: "exit-error", provisional: false };
switch (standingOf(work.value)) {
  case "pending": return { mode: "push-and-exit", provisional: false };  // D2
  case "landed":  return { mode: "exit", provisional: false };           // D1
  case "none":    return { mode: hasSibling ? "exit" : "drop-and-exit", provisional: false };
}
```

The `switch` is exhaustive, so a new standing arm becomes a tsc error. There is no
array whose emptiness can be misread, and the destructive default is now reachable only
from a measured `"none"`.

`push-and-exit-button.tsx` swaps `useResource(pushesByAttemptResource, …)` for
`useResource(attemptWorkResource, …)` in the same `useCombinedResources` gate.

### 3. The exit-menu item

`drop-and-exit-button.tsx` reads `attemptWorkResource` instead of the ledger:
`standingOf(work.value) !== "none"` picks *Complete & Close* over *Drop & Close*. When
`work` is unresolved the entry **hides** (as it already does for a pending decision and
for an active sibling) — the plain *Close* entry covers that case, and a destructive
label over an unknown standing is exactly what we are removing.

### 4. The server-side drop guard — delete the guess (rung 1)

`tasks-core` stops guessing. `maybeDropTaskOnExit` is renamed to what it actually still
knows, `dropTaskIfNoActiveSibling(conversation)`, and its `listPushesForAttempt` read is
deleted — an honest name that cannot be mistaken for the whole exit policy.

The whole policy moves to the plugin named for it, `drop-and-exit/server`:

```ts
/** The one exit-drop policy: never drop when work is at stake OR unmeasurable. */
export async function dropTaskOnExit(conversation: Conversation): Promise<boolean> {
  const work = await getAttemptWork(conversation.attemptId);
  if (!work.resolved) return false;
  if (standingOf(work.value) !== "none") return false;
  return dropTaskIfNoActiveSibling(conversation);
}
```

Both callers — `drop-and-exit/server/internal/handle-drop-and-exit.ts` and
`push-and-exit/server/internal/exit-clean-finalize-job.ts` (which already imports
`drop-and-exit/core`) — call `dropTaskOnExit`. Renaming the tasks-core function makes
the burndown a compile error, not a search.

### 5. `commits-graph` becomes a pure consumer

- `commitDeltaResource`, `computeDelta`, `deltaMemo`, `deltaEtag`, `probeHeadMain`,
  `readBranch`, `readMergeBase`, `readDeltaCounts` move into `attempt-work/server`
  (re-exported from its barrel, since `computeGraph` still needs the probe helpers).
  `shared/protocol.ts` loses `CommitDelta*`.
- `commits-chip.tsx` subscribes `attemptWorkResource` only — dropping *both*
  `commitDeltaResource` and `pushesByAttemptResource`. `↑ahead ↓behind` come from
  `pending.kind === "measured"`; `pending.kind === "no-branch"` renders the existing
  muted `—`; the push count is `landedPushes || ledgerPushes`.
- `computeGraph(worktreePath, landedShas)` is fed by `readLandedShas(attemptId)` instead
  of `listPushesForAttempt`. `graphEtag` drops its `pushedShas` argument (the landed set
  is now a pure function of `mainSha` and the attempt), and `commitsGraphResource`'s
  `dependsOn` drops `pushesResource`.
- `pushesResource` (the global param-less one) exists *only* to drive this cascade —
  see the comment at `tasks-core/server/internal/resources.ts:111`. With both
  `commits-graph` resources off it, check for remaining subscribers and delete it if
  none.
- `commits-graph/CLAUDE.md` gains the note that its landed set is git-measured.

### 6. What stays on the ledger

`pushes` remains the event record of a push: `task-events`, `push-profiling`,
`code-explorer`'s per-push diff (`/api/code/:worktree/push?pushId=`), the review pane,
`docs-button`, and the `pushes.landed` trigger. Those are all *about a specific recorded
push* or are display-only and self-healing. `attempt_push_agg` → `attempts_v` → attempt
status also still lags; it is non-destructive and heals when ingest catches up. Both are
listed as follow-ups, not fixed here.

## Tests

- **`attempt-work/core/standing.test.ts`** (bun:test) — `standingOf` truth table:
  `ahead > 0` ⇒ `pending` even with landed commits; `landedCommits > 0` with `ahead: 0`
  ⇒ `landed`; `ledgerPushes > 0` alone ⇒ `landed` (the pre-trailer-era corroboration);
  `no-branch` + zero landed ⇒ `none`; all-zero measured ⇒ `none`.
- **`attempt-work/core/trailers.test.ts`** (bun:test) — port `parseLog`'s cases from
  `push-watcher.ts`: a commit missing either trailer is skipped; `\0`-delimited records
  parse; multiple trailer values.
- **`attempt-work/server/internal/measure.test.ts`** (bun:test, temp git repo) — the
  load-bearing behaviours, which must be *verified* not asserted:
  - a branch whose commits were rebased onto `main` and fast-forwarded reads
    `ahead: 0`, `landedCommits > 0` (this is the D1 reproduction);
  - a branch with local commits and a clean worktree reads `ahead > 0` (D2);
  - a branch created and never committed on reads `ahead: 0, landedCommits: 0`;
  - a branch rebased onto a newer `main` without authoring anything still reads
    `landedCommits: 0` — main's own commits carry other conversations' trailers;
  - a deleted worktree with a live branch ref still measures `ahead`;
  - a deleted branch reads `{ kind: "no-branch" }`;
  - a git failure (e.g. unreadable main repo) **throws** rather than resolving.
- **`push-and-exit/web/components/exit-mode.test.ts`** (rewrite the ledger cases) —
  `pending` ⇒ `push-and-exit`; `landed` ⇒ `exit`; `none` + no sibling ⇒
  `drop-and-exit`; `none` + sibling ⇒ `exit`; unresolved `work` ⇒ `exit-error`;
  unresolved `work` **with** edited files still ⇒ `push-and-exit` (the ordering above).
- **`commits-graph/server/internal/etag.test.ts`** (update) — `graphEtag` loses its
  `pushedShas` argument.

## Verification

1. `./equin test plugins/tasks/plugins/attempt-work plugins/conversations/plugins/conversation-view/plugins/push-and-exit plugins/conversations/plugins/conversation-view/plugins/commits-graph`
2. `./equin build` (regenerates registries + plugin docs), then
   `./equin check` — `type-check` enumerates the rename burndown,
   `plugins-doc-in-sync` / `plugins-registry-in-sync` after the new plugin.
3. **D1, the reproduction, without touching the queue.** Pick a conversation whose work
   is already in `main` (`conv-1786971113-c3yy` / `8362d52e1`), then delete its ledger
   rows in a scratch worktree DB to simulate the stall and confirm the button is
   unaffected:
   `mcp__singularity__query_db` `select * from pushes where conversation_id = 'conv-…'`
   to confirm the rows exist, then read the resource directly:
   `curl -s 'http://<wt>.localhost:9000/api/resources/attempt-work?attemptId=<att>'`
   ⇒ `{"resolved":true,"value":{"pending":{"kind":"measured","ahead":0,…},"landedCommits":1,"landedPushes":1,…}}`.
   The button must read **Close**, never *Drop & Close*.
4. **D2.** In a scratch worktree: commit something, do **not** push, leave the worktree
   clean (`git status` empty). The button must read **Push & Close**, and the exit-menu
   entry must not offer *Drop & Close*.
5. **The `none` arm survives.** A freshly created attempt with no commits and a clean
   worktree must still read **Drop & Close** — the affordance must not be collateral
   damage.
6. **The unknown arm.** Make the main repo unreadable to the measure (e.g.
   `chmod 000 <mainRepo>/.git/index` and force an invalidate). The button must settle on
   **Close (state unknown)**, enabled and non-destructive — never a spinner, never
   *Drop & Close*.
7. **The destructive write.** With the ledger rows for a landed attempt deleted, POST
   `/api/conversations/:id/drop-and-exit` and confirm the response is
   `{ dropped: false }` and the task's `dropped_at` is still null (`query_db`). Repeat
   through the agent path by calling the `exit_clean` MCP tool.
8. **Chip + pane.** The commits chip shows the push count and the graph pane lists the
   landed commits with the ledger rows deleted. Capture with
   `bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --url http://<wt>.localhost:9000/agents/c/<id> --out /tmp/standing`.

## Ordered implementation

1. `infra/worktree`: extract and export `attemptBranchName(attemptId)`; `setupWorktree`
   uses it. Isolated, no behaviour change.
2. New `plugins/tasks/plugins/attempt-work/`: `core/{protocol,standing,resources,trailers,index}.ts`
   + the three core tests. No consumers yet.
3. `attempt-work/server`: move the delta/probe helpers over from `commits-graph`, add
   `measure.ts`, the memo, `attemptWorkResource`, `getAttemptWork`, `readLandedShas`,
   plus `measure.test.ts`. `push-watcher.ts` switches to `core/trailers`.
4. `deriveExitMode` + `push-and-exit-button.tsx` + the rewritten `exit-mode.test.ts`
   (defects D1 and D2 close here).
5. The exit-menu item (`drop-and-exit-button.tsx`).
6. The server guard: rename `maybeDropTaskOnExit` → `dropTaskIfNoActiveSibling` and drop
   its push read; add `dropTaskOnExit` to `drop-and-exit/server`; repoint both callers.
7. `commits-graph`: delete the delta half, repoint the chip and `computeGraph`, simplify
   `graphEtag`, drop the `pushesResource` dependencies; delete `pushesResource` if it has
   no subscribers left.
8. Docs: `attempt-work/CLAUDE.md` (invariant I3 — a ledger row is positive evidence
   only; and I4), a note in `commits-graph/CLAUDE.md`, and a cross-link from
   `.claude/skills/api-design/SKILL.md`'s absorbable-failure section.
9. `./equin build` && `./equin check`, targeted tests, then manual checks
   3–8.

## Critical files

- **New**: `plugins/tasks/plugins/attempt-work/{core,server}/…`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/web/components/{exit-mode.ts,exit-mode.test.ts,push-and-exit-button.tsx}`
- `plugins/conversations/plugins/conversation-view/plugins/push-and-exit/server/internal/exit-clean-finalize-job.ts`
- `plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/{web/components/drop-and-exit-button.tsx,server/internal/handle-drop-and-exit.ts,server/index.ts}`
- `plugins/tasks/plugins/tasks-core/server/internal/mutations/cross-table.ts`
- `plugins/conversations/plugins/conversation-view/plugins/commits-graph/{shared/protocol.ts,shared/resources.ts,server/internal/{compute-graph,resources,etag}.ts,web/components/commits-chip.tsx}`
- `plugins/tasks/server/internal/push-watcher.ts`
- `plugins/infra/plugins/worktree/server/internal/worktree.ts`

## Rejected

- **Route the empty case to `exit-error`.** Honest, but it deletes the drop affordance
  from the primary button for every clean attempt, because nothing else distinguishes
  "did nothing" from "landed" (`ahead` is 0 in both after a fast-forward merge).
- **Store `baseSha` on `attempts` and count `base..HEAD`.** Cheap and no grep, but a
  rebase onto a newer `main` (`./equin push`, sync-to-head) pulls `main`'s own
  commits into that range, so an attempt that only rebased would read as having authored
  work — silently removing the drop affordance. It also needs a migration and a backfill
  the trailer read does not.
- **Add a `Singularity-Attempt` trailer** so the grep needs no DB join. A better
  primitive, but it cannot answer for any existing commit, so the conversation-trailer
  read would still be needed as the fallback. Worth filing separately.
- **Fix only the display surfaces and leave `maybeDropTaskOnExit`.** It is the write.
- **Fix the queue wedge instead.** That is a real bug, but a decision-grade fact must
  not depend on a background job's liveness in the first place.
- **Keep the ledger as the authority and add a freshness check** ("is ingest caught
  up?"). Same class of mistake one level up: an unenforced guard every future consumer
  must remember, where a git read has no staleness to check.

## Follow-ups (not in this change)

- `attempt_push_agg` → `attempts_v` → attempt/task status still derives from the ledger,
  so a stalled ingest leaves a landed attempt looking unfinished. Non-destructive and
  self-healing, but the same class.
- `conversation-progress`'s `pushed` phase is driven by the `pushes.landed` event, so it
  lags identically.
- The trailer *writer* half is still three string literals (the shell hook, the CLI, the
  check). The `conversation-trailer` check binds them, but a shared home would be rung 3
  instead of rung 4.
- Why `tasks.push-ingest` stalled 40+ minutes behind a wedged queue — worth a
  `queue-health` look on its own.
