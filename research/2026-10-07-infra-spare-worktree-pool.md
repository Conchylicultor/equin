# Spare worktree pool — take the checkout off the launch path

## Context

Launching an agent takes >10 s. Measured on main (2026-10-07):

- `POST /api/conversations` returns in ~0.2 s.
- The `conversations.spawn` job then takes **8–10 s** (outliers 14–30 s), almost all of it
  `git worktree add` in `setupWorktree`.
- `git worktree add` trace: `traverse_trees` 0.25 s, `unpack_trees` **9.4 s** for 15,881 files / 118 MB.
  A plain `tar -x` of the same tree takes 9.2 s and reading every blob takes 1.8 s, so the cost is
  the filesystem creating 16k files, not git.
- Containment already applied in this branch: `-c checkout.workers=0` on the add (10 s → ~5 s).

Gate 2 (legitimacy): each agent needs its own isolated checkout (a product requirement), but it
does not need to be *written while the user waits*. The origin fix is to write it beforehand.

Outcome: a launch claims a pre-written, locked spare checkout. The claim is a rename
(`git worktree move`) plus a branch switch that touches only the files changed on `main` since the
spare was made. The expected `conversations.spawn` time is under 1 s. Cold `worktree add` stays as
the fallback when no spare exists.

## Design

### Spare = a locked, detached checkout of `main` under `.claude/worktrees/spare-<ts>-<rand>`

- `spare-*` deliberately fails `WORKTREE_NAME_RE` (`plugins/infra/plugins/worktree/core/internal/worktree-name.ts:17`).
  The worktree-cleanup reaper (`debug/worktree-cleanup/server/internal/dirs.ts:44-52`), the namespace
  passes and the registry filters all ignore non-canonical names. Do **not** widen the regex.
- The name is unique per spare, so the git admin dir name (`.git/worktrees/spare-…`, which
  `git worktree move` keeps) never collides. Nothing in the repo reads the admin dir by name: every
  operation goes through the checkout path or the gitdir pointer.
- **The lock reason is the readiness marker.** The refill runs `git worktree add --detach <spare> main`
  and then `git worktree lock --reason singularity-spare <spare>`. A spare is claimable only when
  `git worktree list --porcelain` shows `locked singularity-spare`, so a half-written spare is never
  claimed. The lock also protects the clean spare from Claude Code's own `.claude/worktrees` sweep
  (`worktree.ts:166-189`).
- No `./equin` command ever runs inside a spare, so it never gets a registry or data dir.

### Claim, inside `setupWorktree` (`plugins/infra/plugins/worktree/server/internal/worktree.ts:388`)

Keep the existing order: the `existsSync(wtPath)` early return, then the namespace-collision guard.
Then, inside the same `withWorktreeMutateSlot` hold:

1. `listReadySpares(repoRoot)` parses `git worktree list --porcelain` and keeps the
   `spare-*` entries locked with the `singularity-spare` reason, oldest first.
2. For the first spare, run `git worktree unlock <spare>`, then `git worktree move <spare> <wtPath>`.
   A failed move means another claimer won (the move is a rename). In that case try the next spare.
   If none are left, fall through to the cold add.
3. In `wtPath`, run `git switch -c claude-web/<id> main`, or `git switch claude-web/<id>` when
   `attemptBranchExists` (the same convergence the add path has). The switch is a two-tree checkout,
   so it writes only the diff between the spare's commit and current `main`.
4. `ensureWorktreeLocked(repoRoot, wtPath)`, as today.
5. Return `{ source: "spare" | "fresh" }`, so the caller can trigger a refill and the job run can
   record which path it took.

Retry idempotency is unchanged. After a crash past step 2 the dir exists, so the early return
re-locks it. If step 3 had not landed, HEAD is still detached: the early-return branch must check
that HEAD is on `claude-web/<id>` and run step 3 if it is not. This is the one new convergence
case; cover it with a test.

Factor the cold path's argv and add and lock into helpers that the refill reuses, so both share one
`checkout.workers=0`, one timeout and one partial-tree cleanup (`addCheckout`, `worktree.ts:296`).

### Refill: new sub-plugin `plugins/infra/plugins/worktree/plugins/spare-pool`

`infra/worktree` itself stays job-free and CLI-importable. It exports the mechanics:

- `listReadySpares`
- `createSpareWorktree(signal)`: `add --detach` under `withWorktreeMutateSlot`, background
  priority, `checkout.workers=0`, then lock with the reason.
- `pruneSpares(signal)`: removes `spare-*` dirs that are unregistered or unlocked (half-written by a
  killed refill) and older than a few minutes, through the existing `removeWorktree` path.

The `spare-pool` server barrel defines:

- `spareRefillJob = defineJob({ name: "worktree.spare-refill", dedup: "singleton", hold: "minutes",
  inProcess: …, event: z.never() })`. Its run calls `pruneSpares`, then creates spares until the
  ready count reaches `SPARE_TARGET = 1`. Concurrent launches beyond the target fall back to the
  cold add (~5 s with parallel checkout).
- A `defineWarmup({ scope: "host" })` that enqueues the refill at main's boot, so the first launch
  after a restart already has a spare.
- Spares are **not** refreshed when `main` advances. The claim's switch applies the diff, which
  costs roughly the size of what changed: small in practice, and never more than a full add. A
  daily cron on the same job keeps one spare from drifting for weeks.

The trigger after a claim is in `plugins/conversations/server/internal/spawn-job.ts`: when
`setupWorktree` returns `source: "spare"` (or `"fresh"`, meaning the pool was empty), enqueue
`spareRefillJob`. The refill runs off the launch path at background priority, inside the host-wide
mutate slot.

### Out of scope (follow-up)

- Pre-installing `node_modules` in the spare. It would save the agent's first `./equin`
  command 10–25 s, but that time is not launch latency, and a `bun install` result is likely
  path-dependent across `git worktree move`. That needs verifying first.

## Critical files

- `plugins/infra/plugins/worktree/server/internal/worktree.ts`: the claim path in `setupWorktree`,
  the HEAD convergence in its early return, and shared add/lock helpers.
- `plugins/infra/plugins/worktree/server/internal/spare.ts` (new): `listReadySpares`,
  `createSpareWorktree`, `pruneSpares`, exported from `server/index.ts`.
- `plugins/infra/plugins/worktree/plugins/spare-pool/server/` (new): the refill job and the boot
  warm-up.
- `plugins/conversations/server/internal/spawn-job.ts`: enqueue the refill after `setupWorktree`.
- `plugins/infra/plugins/worktree/CLAUDE.md`: a "Spare pool" section covering the lock-reason
  readiness, why `spare-*` is non-canonical, and the claim convergence.

Reused pieces: `withWorktreeMutateSlot` (`mutate-gate.ts`), `ensureWorktreeLocked` and
`attemptBranchExists` (`worktree.ts`), `spawnCaptured` with `background: true`, `defineJob`
(`infra/jobs`), and `defineWarmup` (`infra/warmup`).

## Verification

- Unit tests (`./equin test plugins/infra/plugins/worktree`) against a temporary git repo:
  - A claim takes a ready spare: the result is on `claude-web/<id>`, at `main`'s tree, and locked.
  - An unlocked (half-written) spare is skipped.
  - With no spare, the claim falls back to the cold add.
  - Two concurrent claims of one spare: one wins and the other falls back.
  - Crash convergence: a dir moved but still on a detached HEAD gets switched.
  - A spare made at an older `main` ends at the current `main` after the claim.
- `./equin build`, then launch an agent from the sidebar and check:
  - `job_recent_runs` shows `conversations.spawn` under ~1 s, followed by a `worktree.spare-refill` run.
  - `git worktree list --porcelain` shows a new `spare-*` locked `singularity-spare`.
  - Before and after the refill, the reaper's dry pass does not list the spare.
