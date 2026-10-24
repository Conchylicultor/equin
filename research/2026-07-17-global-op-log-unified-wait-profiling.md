# Unified op-log: standalone `check` events + real wait attribution for every op

## Context

The push/build profiling Gantt (`Debug > Profiling > Push`, and the per-conversation
`/pp` pane) is titled **"Push & Build"** and shows exactly two things: one bar per
push (split `wait | hold`) and one bar per build (a single flat `totalMs` bar).

Two problems, one root cause.

**1. Standalone `./equin check` is an invisible contender.** A direct
`./equin check` acquires its own host CPU grant (`check.ts:113` —
`withHostGrant({ lane, max: cpuBudget().B })`, interactive lane on main /
background elsewhere) and marks a worktree op `waiting-for-lock` → `running`.
But it writes **nothing** durable: there is no `check` record in
`push-contention.jsonl`, no `build-log.jsonl` entry, no build-profile file.
So a check occupies a grant slot — making other agents' builds and pushes
queue — while never appearing in the pane as the cause. The Gantt shows the
contention *effect* but not the contender.

**2. Waits are unattributed, and not only for builds.** Exploration turned up
three separate blind spots:

| Op | Waits on | Recorded today |
|---|---|---|
| `push` | push mutex (`pushPool`, size 1) | ✅ `waitMs`, rendered as the yellow segment |
| `push` | **nested** interactive host grant, inside `runRebasedChecks` (`push.ts:100-108`) | ❌ **invisible** — folded into the `checks` step's wall time |
| `build` | build lock (`acquireBuildLock`, poll loop) | ⚠️ span only, not on the bar |
| `build` | duress valve (`holdThroughValve`, up to 30 min) | ⚠️ `duressHold` span only |
| `build` | host CPU grant (`acquireHostGrant`) | ⚠️ one span, **merged** with valve time across N requeue cycles |
| `check` | host CPU grant | ❌ **nothing at all** |

Build's `startedAt` in `build-log.jsonl` is stamped *before* `acquireBuildLock`
(`build.ts:836`), so the bar's `totalMs` silently swallows every wait: a build
that queued 5 min and worked 1 min renders identically to one that worked 6 min.
And push's `waitMs` is **not** the whole story — a slow `checks` step is
indistinguishably grant-queue time or real check time.

**The root cause is a missing seam, not a missing field.** `createHostSemaphore`
already exposes `AcquireHooks { onWaitStart, onAcquired(waitMs) }`
(`host-semaphore.ts:114-133`), and `HostPool.acquireShare(max, hooks?)` accepts
them. But `withHostGrant` — the *only* entry point build/check/push call — never
forwards them (`host-admission/server/internal/grant.ts:51-61`). Every host-grant
wait is unobservable **by construction**.

**Why not just patch it.** Three ops each hand-roll their own lifecycle logging,
and the duplication has already caused real drift:

- `PushContentionRecord` exists in **three** independent copies — the CLI writer
  (`push-profiler.ts:5-35`), the debug reader
  (`debug/profiling/push/server/internal/read-contention.ts`), and the stats reader
  (`stats/pushes/server/internal/read-contention.ts`). The stats copy **has already
  drifted**: it doesn't model `opSlug`, lacks the synthetic `waiting`/`running`
  outcomes, and silently discards in-flight records.
- `BuildLogRecord` has its own writer/reader copies.
- The Gantt's `PushEntry`/`BuildEntry` are triplicated across the web component,
  the server handler, and the zod schema.
- `finalizeOrphanedPushes` and `finalizeOrphanedBuilds` are near-identical.

Adding `check` as a fourth parallel mechanism would mean a third orphan
reconciler and a fourth record type across ~10 files. The abstraction is missing;
this plan builds it.

**Precedent to mirror.** `worktree-op.ts` already models exactly the right
vocabulary — `WorktreeOp = "build" | "push" | "check"` (`:26`) ×
`WorktreeOpPhase = "waiting-for-lock" | "running"` (`:38`). It is ephemeral by
design (single file per op, overwritten, no history), so it cannot *be* the
durable store — but the durable log should speak its vocabulary rather than
invent a second one.

**Outcome:** every op that competes for a resource — push, build, check —
appears as a bar, with each distinct wait rendered as its own segment, so a stall
is attributable at a glance (self-queued vs. host-starved vs. duress-held)
without opening a detail pane.

## Design

### The record (one type, one writer, one reader, one reconciler)

New plugin `plugins/debug/plugins/profiling/plugins/op-log/`:

```ts
// core/index.ts — pure types + fold logic, no fs
export type OpKind = "build" | "push" | "check";        // mirrors WorktreeOp
export type WaitKind = "push-mutex" | "build-lock" | "host-grant" | "duress-valve";

export interface OpWait { kind: WaitKind; startMs: number; durationMs: number }
export interface OpStep { name: string; startMs: number; durationMs: number }

export interface OpRecord {
  phase: "requested" | "granted" | "completed";
  opId: string;
  kind: OpKind;
  opSlug: string | null;      // liveness key for the reconciler
  worktree: string | null;
  branch: string;
  conversationId: string | null;
  lane: Lane | null;          // interactive | background — explains WHY it waited
  mode?: "worktree" | "from-main";  // push only
  buildId?: string | null;          // build only — joins to build-profile-<id>.json
  requestedAt: string;
  grantedAt: string;
  completedAt: string | null;
  waits: OpWait[];            // ← replaces push's scalar waitMs
  holdMs: number;
  totalMs: number;
  outcome: OpOutcome;         // per-kind union + synthetic "waiting" | "running"
  interrupted: boolean;
  steps: OpStep[];
}
```

`waits` is a **list**, not a scalar, because an op genuinely blocks on several
distinct resources in sequence (build: build-lock → duress-valve → host-grant).
A scalar `waitMs` is what makes today's build stall unattributable. `waitMs` stays
available as a **derived** read-model field (`sum(waits)`) so stats keeps working.

Three phases keep the existing live-bar behaviour (see
`research/2026-06-04-global-push-lock-wait-live-profiling.md`):

| Phase | Written when | Carries |
|---|---|---|
| `requested` | before the first wait | full identity, `requestedAt` |
| `granted` | all waits done, work starts | `opId`, `grantedAt`, `waits[]` |
| `completed` | terminal | everything + `outcome` + `steps` |

Fold at read time per `opId`: terminal wins; `requested` only → synth
`outcome: "waiting"` with a growing wait; `requested + granted` → `"running"`
with fixed `waits[]` + growing `holdMs`. `Date.now()` in the reader is what makes
bars grow — intentional, no polling added.

**Storage:** `~/.singularity/op-log.jsonl`, append-only, same discipline as today.

**Legacy:** `push-contention.jsonl` (5,283 lines) and `build-log.jsonl` (10,483
lines, oldest records carry no `phase` at all) are **not migrated**. The reader
gets a read-only legacy adapter mapping them into `OpRecord`
(`push → waits:[{kind:"push-mutex",…}]`, `build → waits:[]`), so history renders
unchanged with no wait segments. Adapter is deletable once history ages past the
24 h default window.

### Files to change

**1. The seam** — `plugins/infra/plugins/host-admission/server/internal/grant.ts`
- `withHostGrant(opts: { lane; max; hooks?: AcquireHooks }, fn)` → forward `hooks`
  to `cpuPool.acquireShare(opts.max, opts.hooks)`. The hooks already exist and are
  already honoured one layer down; this only stops dropping them. Enables **every**
  host-grant wait below.

**2. New plugin** `plugins/debug/plugins/profiling/plugins/op-log/`
- `core/index.ts` — types above + pure `foldOpRecords(raw, now)` + legacy adapters.
- `core/fold.test.ts` — co-located `bun:test` over the fold: terminal-wins,
  waiting/running synth, legacy mapping, interleaved writers, partial final line.
- `server/index.ts` — `appendOpRecord`, `createOpProfiler(kind, …)`,
  `readOpRecords()`, `finalizeOrphanedOps(isActive)` — **one** reconciler replacing
  the two near-identical ones, keyed on `opSlug` via `isWorktreeOpActive`.

**3. CLI** (`plugins/framework/plugins/cli/bin/`)
- `commands/push.ts` — `createOpProfiler("push")`. Existing
  `markLockRequested`/`markLockAcquired` become the `push-mutex` wait. **New:** pass
  `hooks` into `runRebasedChecks`' `withHostGrant` (`:100-108`) to record the
  nested `host-grant` wait — closing the blind spot inside the `checks` step.
- `commands/build.ts` — `createOpProfiler("build")`, carrying `buildId`. Wrap
  `acquireBuildLock` (`:922-928`) → `build-lock` wait; `hooks` on `withHostGrant`
  → a **per-cycle** `host-grant` wait (un-merging today's single span); valve
  `onHoldStart`/`onHoldEnd` (`ValveDeps`, already wired to `duressHold`) →
  `duress-valve` wait. Replaces `appendBuildLog` (`:836`, `:866-880`).
- `commands/check.ts` — `createOpProfiler("check")` on the **direct** path only,
  gated on the existing `marker = inherited === undefined` (a push-nested check
  inherits its parent's grant and must not double-record). `hooks` on
  `withHostGrant` (`:113`) → `host-grant` wait. Pass the **already-existing**
  `onCheckDone` hook (`RunChecksOptions:85`, which `build.ts:1148` already uses and
  `check.ts` simply omits) → per-check `steps`, giving standalone checks the same
  drill-in build already has.
- **Delete** `push-profiler.ts` and `build-log-writer-global.ts`.

**4. Endpoint** — `plugins/debug/plugins/profiling/plugins/push/`
- `shared/endpoints.ts` — replace `PushEntrySchema`/`BuildEntrySchema` with one
  `OpEntrySchema` (`opId`, `kind`, `startMs`, `waits[]`, `holdMs`, `outcome`,
  `interrupted`, `buildId`, `conversationId`, `lane`); `WorktreeGroup.pushes` +
  `.builds` → `.ops`. Route `GET /api/debug/profiling/push` → `…/ops`; detail →
  `…/ops/:opId` (debug-only endpoints, no external consumers).
- `handle-push-profiling.ts` → `handle-op-profiling.ts`. Keep `canonicalWorktree`
  grouping and `resolveWorktreeTitles`. **`computeWorktreeWindow` / `totalMs` must
  account for `waits[] + holdMs` for every kind** — today it only sums push
  `waitMs+holdMs` and build `totalMs`.
- `read-contention.ts` / `read-build-log.ts` → deleted, replaced by the op-log reader.

**5. Gantt** — `plugins/debug/plugins/profiling/plugins/push/plugins/push-gantt/web/`
- Render `group.ops` in **one** uniform block, replacing the separate builds `.map`
  and pushes `.map`. Each op = `waits[]` segments + a hold segment.
- The existing split is already the right factoring — keep it: `TYPE_FILL` encodes
  *kind* (`build: bg-info`, `push: bg-success`, + **new** `check`), `STATUS_TREATMENT`
  layers *status* (`ring-destructive` failed/interrupted, `animate-pulse` running).
  Add a `WAIT_FILL` map keyed by `WaitKind` so build-lock / host-grant /
  duress-valve are visually distinct — that distinction is the whole point.
- Reuse `INTERRUPTED_MARKER_PX` for interrupted ops (unchanged).
- `onPushClick`/`onBuildClick` → one `onOpClick(op)`; default `title` → `"Ops"`.

**6. Consumers**
- `push-profiling-pane.tsx` (the `/pp` pane) + `push-section.tsx` — dispatch
  `onOpClick` by kind: `build` → `buildProfileDetailPane` (keep the existing
  `buildId == null` toast guard), `push`/`check` → op detail pane.
- `stats/pushes/server/internal/` — **delete** the drifted `read-contention.ts`;
  import the shared reader and filter `kind === "push"`. `handle-wait-time.ts` uses
  derived `waitMs`; `handle-step-breakdown.ts`'s hardcoded `STEP_GROUPS` keeps
  working (push step names unchanged); `handle-throughput.ts` unaffected.

**7. Reconciler** — `debug/profiling/push/server/index.ts:21-25`: replace the two
`finalizeOrphaned*` calls with one `finalizeOrphanedOps(isWorktreeOpActive)`.
Stays an `onReady` boot hook, `isMain()`-gated (not a scheduled job).

### Build-profile spans are untouched

Per-run `build-profile-<id>.json` files (`profiler.ts`, `build:setup` /
`build:checks` / … spans) are a **separate artifact**, joined to the Gantt only by
`buildId`. They need no change — the plan preserves `buildId` on build records so
clicking a build bar still opens its span breakdown.

## Verification

1. `./equin build` to deploy.
2. **Check appears:** run `./equin check` in this worktree. Open
   `http://att-1784284782-oc25.localhost:9000/agents/c/<conv>/pp` → a `check` bar
   on the worktree's row. Click it → per-check steps (`type-check`, `eslint`, …).
3. **Check contends:** saturate the host grant (start a build in another worktree),
   then run `./equin check`. The check bar shows a leading `host-grant` wait
   segment; refresh mid-wait → the bar **grows** (live `requested`-only synth).
4. **Build wait split:** run two builds in the same worktree concurrently. The
   second shows a `build-lock` wait segment before its hold. Under host contention
   it shows a distinct `host-grant` segment — verifying the two are separable.
5. **Push's hidden wait:** with the interactive lane saturated (build on `main`),
   run `./equin push`. The `checks` step now shows a nested `host-grant`
   wait rather than one opaque duration.
6. **Legacy renders:** confirm pre-existing rows (from the 15,766 legacy lines)
   still render, with no wait segments and no crash.
7. **Orphan:** start a waiting check, `kill -9` it. On next main-backend boot,
   `finalizeOrphanedOps` stamps a terminal interrupted record → fixed-width marker.
8. **Stats unbroken:** open the Stats push panes (throughput / wait-time /
   step-breakdown) — still populated from the shared reader.
9. `bun test plugins/debug/plugins/profiling/plugins/op-log` (fold unit tests) and
   `./equin check`.

## Risks

- **Cutover, not migration.** New ops write `op-log.jsonl`; the two legacy files
  become read-only history via the adapter. A build/push straddling the deploy
  writes a `requested` record in the old format and a terminal in the new — the
  reconciler closes the old one as `interrupted`. Cosmetic, one-time.
- **`withHostGrant` signature change** — all call sites are in-repo
  (`build.ts`, `check.ts`, `push.ts`); `hooks` is optional, so it's additive.
- **Per-cycle grant waits across requeues** (build) produce multiple `host-grant`
  entries in `waits[]`. Intended — that's the un-merging. The Gantt must handle
  N wait segments, not assume one.
- **`opSlug` vs `worktree` divergence** — unchanged from today; reconciler keys on
  `opSlug`, null → treated inactive.
- **Endpoint rename** touches the debug pane + `/pp` pane + stats; all in-repo.
