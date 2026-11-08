# Trigger-bound jobs keyed and settled on their event's subject

Task att-1794151725-jpetf0 (split from att-1794151100-4163ge; `research/2026-11-08-global-app-health-24h-after.md` §2.6 / §6 item 11).

## Context

One `page.blocksChanged` emit runs six `dedup: "none"` jobs (search reindex, links reindex,
reminders reconcile, attachment reconcile, history schedule, auto-icon schedule). On main:
396 emits in 80 min over 7 pages, 322 of them < 5 s after the previous emit for the same page.
Every run writes a `job_runs` ring row and a `job_run_stats` row through the change feed —
the top drivers of main's route traffic.

All six are idempotent recomputes of the page's *current* state: the work should be per
*settled change*, not per edit event. They cannot say so because:

1. **A trigger's input is its constant `with`.** The subject (`pageId`) arrives in `event`, and
   `Dedup.key` is a function of `input` only. So a trigger-bound per-subject job can be
   `"none"` (one run per emit) or `"singleton"` (drops other pages) — nothing else.
2. **There is no settle.** A key only collapses rows that are still pending; edits arrive seconds
   apart and a run takes ~20 ms, so nothing is pending to fold into. Two of the six jobs
   (`pages.history.schedule`, `pages.auto-icon.schedule`) exist only to hand-roll a debounce by
   re-enqueueing a keyed job with `runAt = now + N`.

## Design

### 1. events: a trigger's `with` may name fields of its event (`eventField`)

`with` stays *data* (it is stored in the trigger row's `job_with` JSON), but a value may be a
reference to the event payload: `with: { pageId: eventField("pageId") }`, stored as
`{ "pageId": { "$eventField": "pageId" } }`. Delivery (`resolveDelivery`) resolves every
reference against the emitted payload *before* parsing the target's input schema, so the
target receives a plain `{ pageId }` input — exactly what a direct `.enqueue({ pageId })` gives.

Consequences:
- A per-subject job is one job for every caller: trigger, backfill, Regenerate. It keys on its
  input like any other keyed job, with `event: z.never()`.
- Works for declared `Trigger` contributions and runtime `trigger()` rows alike (data, not a
  closure — nothing to look up in memory at dispatch).
- Typed: `TriggerWith<I, P>` lets each input field be its value or an `eventField(k)` whose
  payload field `P[k]` is assignable to it. A missing field at runtime is contract drift
  (reported, skipped) through the existing input-parse path.

### 2. jobs: `dedup: { key, settle }` — debounce with a ceiling

```ts
dedup: { key: ({ pageId }) => pageId, settle: { quietMs: 2_000, maxWaitMs: 30_000 } }
```

Every enqueue of a key moves its pending row's due time to `now + quietMs`, but never past
`pendingRow.createdAt + maxWaitMs` — so a burst collapses to one run after the edits stop, and
a page edited without pause (an agent editing for minutes) is still processed every
`maxWaitMs`. Both fields required: the ceiling is a choice, not a default to forget (rung 2).
`settle` exists only on the keyed arm (a singleton/none row has nothing to settle onto) and
excludes a caller `runAt` (the queue derives it).

The queue derives the due time (`JobRowOpts.settle`), one rule per provider:
- graphile (`graphile-queue.ts`): `add_job`'s default `replace` mode already moves `run_at` on a
  pending row; the ceiling reads the pending row's `created_at` (kept by graphile's upsert) in
  the same statement as `add_job` on the tx path, and one indexed select before `addJob` on the
  pool path. A locked (running) row releases the key, so an edit landing mid-run gets a fresh
  row — never lost.
- in-process (`in-process-queue.ts`): the collapse in `admit()` applies the same min.

### 3. The six subscribers

| job | change |
|---|---|
| `pages.search.reindex`, `page.links.reindex`, `page.reminders.reconcile`, `page.attachment-block.reconcile` | input `{ pageId }`, `event: z.never()`, `dedup: { key: pageId, settle: { quietMs: 2_000, maxWaitMs: 30_000 } }`; Trigger `with: { pageId: eventField("pageId") }` |
| `pages.history.snapshot` | bound directly, settle 4 s / 60 s; **`pages.history.schedule` deleted** |
| `pages.auto-icon.generate` | bound directly, settle 10 s / 120 s; **`pages.auto-icon.schedule` deleted** |

Rows queued in the old shapes (a scheduler row, or a reindex row with `input: {}`) are
`instant` rows that run within milliseconds of their emit, so none survive a deploy in
practice. A straggler fails loudly and once: the worker reports `unknown job` / `input schema
drift` and now dead-letters the row after that one attempt (`worker.ts` `dispatch`, matching the
in-process queue's `retry: false`) instead of burning its retry budget — it shows as a
dead-letter, never silently dropped. Its page's derived state catches up on the page's next
edit (search and links also through their boot backfills).
Old trigger rows (`with: {}`) are replaced by the boot sync (`syncTriggerContributions` owns
every declared row).

### 4. What remains: one `events.dispatch` per transactional emit

Keyed targets of a tx emit cannot be enqueued on the emitter's transaction (a `job_key`
upsert holds that key's row lock to commit — cross-page lock-order deadlocks, see
`enqueuesOnCallerTx`). So each tx emit still costs one `events.dispatch` run (carrying all six
deliveries). Per edit: **6 runs → 1**; per settled burst: 6 runs (the targets). Eliminating
the outbox run needs a post-commit, durable outbox outside graphile — filed as a follow-up,
not done here.

## Files

- `plugins/infra/plugins/jobs/server/internal/registry.ts` — `Dedup` settle arm, enqueue passes
  `settle`; `queue.ts` — `JobRowOpts.settle`.
- `plugins/infra/plugins/jobs/machine/internal/graphile-queue.ts` — due-time derivation.
- `plugins/infra/plugins/jobs/plugins/in-process/server/internal/in-process-queue.ts` — same.
- `plugins/infra/plugins/events/server/internal/{trigger.ts,deliver.ts,event-field.ts}` —
  `eventField`, `TriggerWith`, resolution at delivery.
- The six subscriber jobs + their plugin barrels / CLAUDE.md.

## Verification

- Unit: settle due-time derivation (both providers), `eventField` resolution + drift.
- Worktree build: type ~30 edits into one page within a few seconds; count `job_runs` rows per
  job name before/after (main's numbers above as baseline): expect 1 `events.dispatch` per
  edit and one run per subscriber per burst; search/links/history/auto-icon still update.

## Measured (worktree build, 2026-11-08)

`./equin run plugins/page/plugins/editor/e2e/edit-burst.ts` — 20 keystrokes 1.5 s apart into a
fresh page, then 15 s of quiet, then the page trashed. Diff of `job_run_stats.runs`:

| job | before (per design: 6 per emit) | after |
|---|---|---|
| `page.blocksChanged` emits | 23 | 23 |
| search / links / reminders / attachments reindex | 23 each (92) | 3 each (12) — the 30 s ceiling, the end of the burst, the trash |
| `pages.history.schedule` + `pages.auto-icon.schedule` | 46 | gone |
| `pages.history.snapshot` / `pages.auto-icon.generate` | ~1 / ~1 | 2 / 1 |
| **subscriber runs** | **~140** | **15** |
| `events.dispatch` (tx-emit outbox) | 0 (`none` targets went inline) | 21 |
| **total job runs** | **~140** | **36** |

The remaining 21 are the outbox run per transactional emit (§4) — now the biggest remaining
cost, filed as the follow-up. `auto-icon-verify.ts` (12 checks) passes on the settled path.
