# Retire the legacy op-log adapters

## Context

Three push bars in the Debug → Profiling op Gantt have been rendering as
never-completing for days, growing wider on every refresh. They are not real
in-flight ops.

**What they are.** Three pushes from 2026-07-17/18 that were hard-killed
mid-flight and never wrote a terminal record, living in the pre-cutover
`~/.singularity/push-contention.jsonl`:

| pushId      | requested            | synthesized state |
| ----------- | -------------------- | ----------------- |
| `61f309e1…` | 2026-07-17T23:30:04Z | `waiting`         |
| `050d094d…` | 2026-07-18T03:02:46Z | `running`         |
| `2a6e70ea…` | 2026-07-18T12:30:06Z | `running`         |

The current `op-log.jsonl` is clean — 152 ops, zero orphans.

**Why they are permanent.** Two independent defects compound:

1. `read.ts:81-82` asserts *"The legacy files keep their own reconcilers, so
   closing their orphans from here would double-write them."* This is false.
   Commit `51db34fc9` (the op-log cutover) deleted `finalizeOrphanedPushes`
   along with `read-contention.ts`. No reconciler exists for these files, so
   nothing can ever close them.
2. `foldLegacyPushRecords` clocks unterminated records against `now`
   (`totalMs: Math.max(0, now - requestedMs)`), so their spans grow forever.
   Its sibling `foldLegacyBuildRecords` correctly renders unpaired records as
   zero-width interrupted markers — the two halves of the same file disagree.

**Why the 24 h window does not save us.** A conversation-scoped pane
(`?worktree=…`) takes the overlap branch in `handle-op-profiling.ts:70`:
`endMsOf(r) >= cutoffStart && startMsOf(r) <= cutoffEnd`. An unterminated
record's `endMs` is always `now`, so it overlaps *every* window regardless of
age. These three leak into every conversation-scoped profiling pane and drag
the shared time axis back to Jul 17.

**Intended outcome.** Delete the legacy adapters entirely rather than patch the
live-clocking. The adapters' own exit criterion is already met — `legacy.ts:14`
states *"Both adapters are deletable as one unit each, once history ages past
the pane's 24 h default window"*, and the two files were last written
2026-07-18 13:20 / 14:30. Deleting makes the phantom bars structurally
impossible, removes ~250 lines plus a stale-comment landmine, and drops ~15.8k
lines of dead-format JSONL parsed on every request.

## Scope

Pure deletion. Two things deliberately **out of scope**:

- **The two `.jsonl` files on disk stay.** Once the adapters are gone nothing
  reads them; they are 4.7 MB of inert bytes. `rm` them whenever — the code
  change does not depend on it.
- **A residual phantom-bar path in the NEW log is not addressed here.** An op
  whose `requested` head is clipped by the reader's 8 MB byte budget is
  explicitly never reconciled (`read.ts:86-92`), and would grow the same way.
  It needs a clipped head to trigger, so it is rare. File as a follow-up task,
  do not fold in.

## Changes

### 1. Delete `core/internal/legacy.ts`

`plugins/debug/plugins/profiling/plugins/op-log/core/internal/legacy.ts` —
delete the whole 251-line file. Everything in it (`RawLegacyPushRecord`,
`RawLegacyBuildRecord`, `foldLegacyPushRecords`, `foldLegacyBuildRecords`, and
the private `EPOCH` / `msBetween` / `LegacyPushGroup` / `groupLegacyPushes`
helpers) is legacy-only.

> `EPOCH` is also defined independently in `fold.ts:5` — that one stays.

### 2. Strip the core barrel

`core/index.ts` — delete lines 15-16:

```ts
export type { RawLegacyBuildRecord, RawLegacyPushRecord } from "./internal/legacy";
export { foldLegacyBuildRecords, foldLegacyPushRecords } from "./internal/legacy";
```

### 3. Strip the reader

`server/internal/read.ts`:

- Imports: drop `foldLegacyBuildRecords`, `foldLegacyPushRecords`,
  `RawLegacyBuildRecord`, `RawLegacyPushRecord` (lines 2-3, 7-8), the
  `readJsonlTail` import (line 11 — becomes fully unused; `opLogSink.readJsonlTail()`
  at line 29 is the sink's own method, a different binding), and
  `LEGACY_BUILD_FILE` / `LEGACY_PUSH_FILE` from line 12.
- `readOpRecords()` collapses to the single fold. Lines 50-51 (the two
  `readJsonlTail` calls) and 57-58 (the two spreads) go:

```ts
export function readOpRecords(): OpRecord[] {
  return foldOpRecords(readRawOpRecords(), Date.now());
}
```

- Rewrite the doc comment at lines 34-46: the "384 MB → 24 MB" figure counted
  three files; with one sink left the bound is the sink's own 8 MB budget.
  Keep the `includeRotated`-deliberately-unset rationale — that is still live.
- **Fix the stale comment at `read.ts:81-82`.** Replace *"Scope is the NEW log
  only. The legacy files keep their own reconcilers…"* — the premise was false
  and is what let these three orphans persist. The reconciler now has exactly
  one log to close; say so.

### 4. Strip the server barrel and its description

`server/index.ts`:

- Line 3 → `export { OP_LOG_FILE } from "./internal/jsonl";`
- Line 13 description: drop `(incl. read-only legacy adapters)` → `"…the
  merged reader, and the single orphan reconciler."`

> The description edit is load-bearing: it is the source for the autogenerated
> blocks in `CLAUDE.md` / `docs/plugins-*.md` (see step 7).

### 5. Strip the file constants

`server/internal/jsonl.ts` — delete lines 8-19 (the doc block and both
constants). Also amend the comment at lines 21-26, which opens *"The op log is
the ONE writable durable artifact here — the two legacy files are read-only
history"*; the contrast no longer has a referent. `OP_LOG_FILE`, `opLogSink`,
and `appendOpLog` are untouched — nothing in this file depends on the legacy
constants.

### 6. Strip the tests

`core/fold.test.ts` (680 lines):

- Delete the legacy imports, lines 3-4.
- Delete `describe("foldLegacyPushRecords", …)` **lines 329-401** and
  `describe("foldLegacyBuildRecords", …)` **lines 403-473** (the contiguous
  block 329-473).
- Everything else stays: the `foldOpRecords` terminal/waiting/running/
  interleaved suites, `partial final line`, the end-to-end build sequence,
  `steps`, and `sumWaits`.

### 7. Docs

- `plugins/debug/plugins/profiling/plugins/op-log/CLAUDE.md` — delete the
  hand-written `## Storage and the legacy cutover` section, **lines 102-116**.
  Everything below the `<!-- AUTOGENERATED:BEGIN -->` marker regenerates from
  the barrels on the next `./equin build`; do **not** hand-edit it.
- `docs/plugins-details.md` and `docs/plugins-compact.md` are fully generated —
  `./equin build` refreshes them, and the `plugins-doc-in-sync` check
  gates it.
- `research/2026-07-17-global-op-log-unified-wait-profiling.md` — leave as-is.
  It is a dated historical design record, not live reference documentation.

## Critical files

| Path                                                                       | Action                       |
| -------------------------------------------------------------------------- | ---------------------------- |
| `plugins/debug/plugins/profiling/plugins/op-log/core/internal/legacy.ts`     | delete (whole file)          |
| `plugins/debug/plugins/profiling/plugins/op-log/core/index.ts`               | drop lines 15-16             |
| `plugins/debug/plugins/profiling/plugins/op-log/core/fold.test.ts`           | drop lines 3-4, 329-473      |
| `plugins/debug/plugins/profiling/plugins/op-log/server/internal/read.ts`     | collapse reader, fix comment |
| `plugins/debug/plugins/profiling/plugins/op-log/server/internal/jsonl.ts`    | drop lines 8-19, amend 21-26 |
| `plugins/debug/plugins/profiling/plugins/op-log/server/index.ts`             | drop 2 exports, edit description |
| `plugins/debug/plugins/profiling/plugins/op-log/CLAUDE.md`                   | drop lines 102-116           |

Nothing outside this plugin imports any removed symbol — verified repo-wide.
`LEGACY_*` were barrel-exported but had no external consumer. No check,
retention policy, or growth-bound registry references them: they were
deliberately never `defineFileSink`s, precisely so they stayed invisible to
that machinery.

## Verification

1. **Types + lint:** `./equin check type-check` — catches any missed
   import and the now-unused `readJsonlTail`.
2. **Unit tests:** `bun test plugins/debug/plugins/profiling/plugins/op-log` —
   the surviving `foldOpRecords` / `sumWaits` suites must all pass.
3. **Full checks:** `./equin check` — `plugins-doc-in-sync` confirms the
   generated docs match the new barrels.
4. **Deploy:** `./equin build`.
5. **The actual bug — confirm the three bars are gone.** Open the
   conversation-scoped pane that showed them:
   `http://att-1784539909-po60.localhost:9000/agents/c/conv-1784492705-ddox/pp`
   Expect: no `waiting`/`running` bars dated Jul 17-18, no rows with a null/blank
   worktree label, and a time axis starting within the recent window instead of
   Jul 17.
6. **Confirm real history still renders.** The unscoped Debug → Profiling ops
   Gantt must still show recent build/push/check bars from `op-log.jsonl` with
   their wait segments — the deletion must remove only pre-cutover rows.
7. **Confirm the reader is single-source.** Optional sanity check that no
   process still touches the frozen files:
   `ls -l ~/.singularity/push-contention.jsonl ~/.singularity/build-log.jsonl`
   — mtimes must stay at 2026-07-18 across a build and a push.

## Follow-up (not this change)

File a task: *an op whose `requested` head is clipped by the op-log reader's
8 MB byte budget is never reconciled and renders as an ever-growing bar that
overlaps every conversation-scoped window.* Same failure shape as the three
bars this change removes, reachable through the new log once it exceeds the
read budget.
