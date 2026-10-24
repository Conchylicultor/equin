# An attempt's status may claim what a fact proves, never what a missing row implies

Date: 2026-08-20
Category: tasks (tasks/tasks-core, tasks/attempt-status, tasks/attempt-work)

Third and last of the "the `pushes` table is not an oracle" trilogy:

1. `research/2026-08-17-global-attempt-work-git-derived-standing.md` — **I3/I4**, the
   *destructive* decision (Drop & Close) stops reading the ledger as an authority.
2. `research/2026-08-18-global-push-ledger-git-projection.md` — **I5**, the ledger stops
   being the output of a job and becomes a projection of `main`, refreshed on write and
   guaranteed on read.
3. This one — **I6**, the derived *status* stops spelling a conclusion the ledger's
   absence cannot support.

## Context

`attempts_v.status` (`tasks-core/server/internal/views.ts:45`) ends its CASE with
`ELSE 'abandoned'`, and `tasks_v` reads the same rollup one hop up (`hasCompleted`
requires `attempts_v.status = 'completed'`). So an attempt with no `pushes` row and no
live conversation is rendered as a muted italic **"Abandoned"** badge, and its task falls
through to **"Attempted"** with a null `finishedAt`.

That `ELSE` is the only arm in the whole derivation that is **a claim made from the
absence of evidence**. Every other arm names a fact the row proves. The absence of a
ledger row means one of at least four different things:

| what actually happened | count today |
| --- | --- |
| the attempt genuinely never pushed (the task was dropped, the agent gave up) | 876 |
| the attempt finished without needing to push — a research/answer task, or a re-attempt whose sibling landed | ~128 |
| work landed but carries no attributable trailer (`--from-main`, a hand-merge) — permanently invisible to the ledger **and** to `attempt-work`'s git measurement | unmeasurable |
| the ledger has not caught up yet | ~0 since I5, but see Follow-ups |

(measured on `singularity`: 1014 attempts read `abandoned`, of which 876 sit on a dropped
task and 128 on a task that is neither dropped nor held.)

The view collapses all four onto one word, and picks the most damning one.

### The second bug in the same arm — it is not only about push lag

`has_live_conv` is `status NOT IN ('gone','done')`. **Hibernation writes `gone`** on an
idle pane to reclaim resources (`conversations/hibernation`), and `gone` is precisely the
status `resumeConversation` requires in order to resume — "dormant, not finished", in
`attempt-work/CLAUDE.md`'s own words.

So a *live, resumable, hibernated* attempt that has not pushed yet has
`has_live_conv = false`, `has_push = null`, and falls straight through to
**`abandoned`**. No push lag involved at all. The rollup already carries the column that
tells these apart — `has_open_conv` (`status <> 'done'`) — and the status CASE simply
does not read it. This is the same defect wearing a different hat: a positive fact exists,
the CASE ignores it, and the negative-evidence arm swallows the case.

`retained` and `active` diverge on exactly this state, and today that divergence is
visible only to `worktree-cleanup`'s reaper. Nothing in the UI ever says *why* a finished-
looking attempt still holds its checkout.

### Why this is a layer below the Drop & Close fix, and must agree with it

The button now reads `standingOf(getAttemptWork(id)) → "none" | "pending" | "landed"`
(I4), where `ledgerPushes` is only ever **ORed into** a positive answer (I3). The badge
reads `attempts_v.status`. Today these are two independent derivations of "did this land",
and nothing keeps them from contradicting each other on screen: the badge can say
*Abandoned* while the button offers *Push & Exit* because the standing measured unpushed
commits ahead.

## The invariant

> **I6.** Every arm of `attempts_v.status` names a fact the row **proves**. A `pushes`
> row may only ever *promote* an attempt to a landed claim (`pushed` / `completed`); its
> absence may never select a claim of its own. When there is no landed evidence, the
> status reports how the attempt **ended** — a fact the conversation rollup does prove —
> and says nothing about what did or did not land.

I6 is the view-layer form of I3. Its consequence is the coherence property that was
missing:

> `attempts_v.status` can never contradict `standingOf`, because the only landed-claiming
> arm (`completed`) is backed by the very rows `standingOf` ORs into `"landed"`, and no
> arm claims "nothing landed" at all.

The three invariants compose: **I5** makes the ledger complete, **I3** makes its absence
mean nothing, **I6** makes the derived status stop pretending otherwise.

## Design

### 1. `abandoned` is deleted — the claim loses its spelling

Rung 1 of the fix ladder. After this change there is no `AttemptStatus` value meaning
"abandoned", so no view arm, no consumer, and no future author can express the conclusion
at all. Shrinking-and-growing the enum makes `tsc` enumerate every consumer (rung 2); the
blast radius is small and fully enumerated in *Critical files*.

The `ELSE` splits on `has_open_conv`, a column the rollup already maintains:

```
CASE
  WHEN has_conv IS NULL                       THEN 'pending'    -- no conversation yet
  WHEN has_live_conv AND has_push IS NULL     THEN 'in_progress'
  WHEN has_live_conv AND has_push             THEN 'pushed'
  WHEN has_push                               THEN 'completed'  -- landed; the only landed claim
  WHEN has_open_conv                          THEN 'dormant'    -- `gone`, nobody closed it: resumable
  ELSE                                             'closed'     -- every conversation explicitly closed
END
```

| status | the fact it names | what it does **not** say |
| --- | --- | --- |
| `pending` | no conversation exists yet | — |
| `in_progress` | a conversation is live | — |
| `pushed` | a conversation is live **and** a landed commit is recorded | — |
| `completed` | no live conversation **and** a landed commit is recorded | — |
| `dormant` | no live conversation, but one is still open (`gone`) — the process is not running and the attempt is resumable | nothing about what landed |
| `closed` | every conversation was explicitly closed — the session is over | nothing about what landed |

Both new arms are selected by a positive column. Neither is a verdict on the work.

`dormant` sits **below** the landed arms deliberately: when there is evidence, the
evidence wins. `dormant` exists to stop *absence* being read as abandonment, not to
outrank a true claim.

Naming: `closed` is the fact (`markConversationClosed` is literally the mutation that
produces it). `dormant` is the word `attempt-work/CLAUDE.md` already uses for a `gone`
conversation, so the two plugins end up with one vocabulary.

### 2. `attempts_v.finished_at` stops stamping a resumable attempt

The second arm currently reads "has conversations, none live, no push ⇒
`max(ended_at)`", which under the split hands a *finished* timestamp to `dormant` — an
attempt that is not finished and can be resumed. It gains the same
`NOT has_open_conv` qualifier, so only `closed` (and `completed`, via the first arm) ever
carries one. Free of consequence: `attempts_v.finished_at` has no consumer today (only
`tasks_v.finished_at` does, computed independently from `min(pushes.created_at)`).

### 3. The badge stops looking like a failure

`ATTEMPT_STATUS_META` (`attempt-status/web/components/attempt-status.tsx:15`) keys on
`Attempt["status"]`, so the enum change is a `tsc` error until both arms are given
treatment. The current `abandoned` styling is `bg-muted text-muted-foreground italic` —
the italic is the "dead / struck-through" affordance, and it is what makes 1012 ordinary
closed sessions read as failures.

- `closed` — `bg-muted text-muted-foreground`, **no italic**. A neutral terminal state,
  visually distinct from the green `completed` without editorialising. The status-colour
  doctrine already in `task-status` ("colour reserved for what needs action") says a
  neutral end state must recede, not be marked up.
- `dormant` — `bg-muted text-muted-foreground`, label "Dormant". Deliberately *not*
  warning-coloured: hibernation is routine, and a warning tint here would cry wolf on
  every idle pane. The label alone carries the distinction from `pending`, and it is the
  first time the UI says out loud why the checkout is still held.

Labels come from `formatStatusLabel` (mechanical sentence-case), so "Closed" / "Dormant"
need no separate authoring.

### 4. `tasks_v` is deliberately unchanged

Audited against I6 and it already holds: `done` requires positive evidence
(`hasCompleted`), and `attempted` claims only *"this task has an attempt"* — a positive
fact — not *"the attempt failed"*. Its badge (`MdIncompleteCircle`, muted, "Attempted") is
already the honest rendering of "attempted, nothing recorded as landed".

So a task whose work landed untrailered still reads `attempted` rather than `done`. That
is the correct answer for a system with no evidence: I6 removes the **false** status, and
what is left is a **missing** one — which is what the report asked for, and the only thing
truthfully available at this layer.

The chart misattribution in the report is already gone, and by a different mechanism:
`tasks_v.finished_at` is `min(pushes.created_at)`, and `pushes.created_at` is the commit's
*committer* date (`push-ledger/raw-reads.ts:56-63`), not the ingest instant — so a late
reconcile files the completion on the day it happened, never the day it was noticed.

### 5. Enforcement

- **Rung 1 (inexpressible)** — the enum value is gone.
- **Rung 2 (type error)** — `ATTEMPT_STATUS_META` is `Record<Attempt["status"], …>`;
  `tsc` enumerates every consumer of the union.
- **Rung 4 / test** — `views.test.ts` gains the full truth table over
  (`has_conv` × `has_live_conv` × `has_open_conv` × `has_push`), asserting the status of
  every cell **and** the two machine-checkable statements of I6 itself:
  - `status ∈ {pushed, completed} ⇒ a pushes row exists` (only evidence promotes), and
  - no cell's status is a function of `has_push` being *absent* — i.e. flipping
    `has_push` from absent to present may only move a row *up* the table, never sideways
    between two non-landed arms.

  A lint rule ("no unqualified `ELSE` in a status CASE") was considered and rejected as
  brittle syntax-matching; the truth table pins the semantics instead.

## Tests

`tasks-core/server/internal/views.test.ts` (real DB, real migration chain, view DDL
compiled from the exported declarations — the existing harness):

- the six-cell truth table above, one seeded attempt per cell;
- the hibernation regression: an attempt with one `gone` conversation and no push reads
  `dormant`, **not** `abandoned`/`closed`, and `retained` is true while `active` is false;
- `finished_at` is null for `dormant` and non-null for `closed`;
- the coherence assertion: for every cell, `status = 'completed'` iff a `pushes` row
  exists and no conversation is live;
- unchanged: the existing hold-precedence and `task_blocking_v` agreement suites must
  still pass — `depIsBlocking` and `tasks_v.hasCompleted` compare against `'completed'`
  only and are untouched by the split.

## Verification

1. `./equin test plugins/tasks/plugins/tasks-core`
2. `./equin build` (background), then `./equin check` — `type-check` for the
   enum burndown, `plugins-doc-in-sync`.
3. `query_db` on `singularity` after the deploy: `select status, count(*) from attempts_v
   group by 1` returns no `abandoned` row, ~1012 `closed`, ~2 `dormant`, and `completed` /
   `in_progress` / `pushed` unchanged in count.
4. `select count(*) from tasks_v where status = 'done'` is unchanged across the deploy —
   the task layer must not move.
5. A task detail pane's Attempts section (`task-events`) shows "Closed" in plain muted
   type where it showed italic "Abandoned".

## Rejected

- **Rename `abandoned` → `closed` and stop there.** Cheapest, and wrong: it leaves the
  hibernated-attempt case reading as a terminal end state, and leaves `has_open_conv` — a
  positive fact already materialised — unread. The point of I6 is that each arm names a
  fact, not that one word is nicer.
- **Have the view read `attempt-work`'s git-measured standing.** The obvious symmetry with
  the Drop & Close fix, and it buys nothing here: for the *landed* half, `attempt-work`
  and the ledger measure the same thing from the same trailers (I5), so the answers are
  identical by construction. The half `attempt-work` adds — `pending`, unpushed commits
  ahead — needs a `rev-list` per branch, which cannot be a column in a view over 4000
  attempts. Materialising it into a table would re-create the lagging-projection problem
  this trilogy exists to remove.
- **Add an `unknown` status for "no evidence either way".** Rejected: it is not unknown
  what happened to the *session* — the rollup proves whether it was closed or is still
  open. Only the *landing* is unknown, and the fix for that is to stop making landing
  claims from absence, not to invent a status that renders as a shrug on 1014 rows.
- **Gate `listAttempts` / `listTasks` on `ensurePushLedgerFresh()`.** Re-considered and
  re-rejected on the same grounds as the predecessor doc: those feed `bootCritical`
  resources, and a git read on the boot-snapshot path turns a transient git failure into a
  failed task list.
- **Keep the italic on `closed`.** It is the affordance that made the report's author read
  a merged attempt as dead. A neutral end state gets neutral type.

## Ordered implementation

1. `core/internal/schema.ts` — `AttemptStatusSchema`: drop `abandoned`, add
   `dormant` + `closed`. Everything downstream is now a `tsc` error.
2. `server/internal/views.ts` — the CASE split, the `finished_at` qualifier, and the I6
   comment block above the CASE (this file is where the reasoning has to live; it already
   carries the PROGRESS-vs-RETENTION and hold-precedence notes).
3. `server/internal/views.test.ts` — the truth table + coherence assertions.
4. `attempt-status/web/components/attempt-status.tsx` — the two new keys, italic removed;
   `attempt-status/CLAUDE.md` — the prose on why no status editorialises.
5. Docs: I6 in `tasks-core/CLAUDE.md` beside I5; the cross-link in `attempt-work/CLAUDE.md`
   § I3 (the view now holds the same discipline the button does).
6. `./equin build` (background) → `./equin check` → the manual checks 3–5.

## Critical files

- `plugins/tasks/plugins/tasks-core/core/internal/schema.ts` (`AttemptStatusSchema`)
- `plugins/tasks/plugins/tasks-core/server/internal/views.ts` (`attempts_v`)
- `plugins/tasks/plugins/tasks-core/server/internal/views.test.ts`
- `plugins/tasks/plugins/attempt-status/web/components/attempt-status.tsx`
- Docs: `tasks-core/CLAUDE.md`, `attempt-work/CLAUDE.md`, `attempt-status/CLAUDE.md`

Consumers confirmed **unaffected** (they compare against `'completed'` only):
`views.ts:depIsBlocking` → `task_blocking_v`, `views.ts:tasks_v.hasCompleted`,
`stats/tasks` (reads `tasks_v.status`/`finishedAt`). Render sites of the badge:
`tasks/task-events`, `active-data/task`.

## Follow-ups (not in this change)

- **RESOLVED (2026-08-27) — the reconcile watermark could lose a commit permanently.**
  The walk is now bounded by a coverage frontier and the freshness memo is signed on the
  attribution set as well as `main`'s tip:
  `research/2026-08-27-tasks-push-ledger-coverage-frontier.md`.
- **`--from-main` and hand-merged commits carry no conversation trailer**, so no layer of
  this trilogy can attribute them. Unchanged, and now the only remaining reason a landed
  attempt can read `closed`. The `conversation-trailer` pre-push check already makes this
  the exception rather than the rule.
