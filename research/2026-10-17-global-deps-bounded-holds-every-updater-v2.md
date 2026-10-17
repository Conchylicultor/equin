# Bounded holds v2: a lapsed hold is reviewed, never released

Status: **plan — agreed 2026-10-17, implementing.** Supersedes the expiry semantics of [v1](./2026-10-17-global-deps-bounded-holds-every-updater.md); everything else in v1 (one shared `Hold`, `holds.read`, the 90-day bound checks, HELD rows) stands.

## Context

v1 made a hold *inert* the day after its `until`: the updater proposed the held release again and only the gates stood between it and main. A hold usually guards something the suites do not exercise (a runtime path, a platform quirk, a missing wheel), so a clean gate run would re-land the very release the hold was set against — and the agent would not even be told it had been held.

The intended model: **a hold is never released automatically.** Its date is a *review deadline*. When it passes, the upgrade task must look at the reason, then either lift the hold (and let the release move) or renew it — and the task is not done until every lapsed hold has been dealt with.

## Design

### 1. `until` → `reviewBy`; a hold is honoured whatever its date

- `HoldSchema.until` is renamed `reviewBy` (`YYYY-MM-DD`, at most 90 days out when set — the bound checks are unchanged).
- `heldBy(holds, name, version, compare)` drops `today`: every declared hold blocks its releases until a diff deletes it. `holdActive` goes.
- `holdState(hold, today)`: `"active"` through `reviewBy`, `"lapsed"` after. `lapsedHolds(holds, today)`.
- Consequences: `upgradeTarget`, `lockProblems` (a locked release under ANY hold is a problem again), `newestCpython`, npm's `planNpm` lose their `today`.

### 2. A lapsed hold is the unit of work, not a row

A lapsed hold whose release has since been superseded covers no outdated row, yet still needs deleting — so the work item is the hold itself, read from `holds.read`, not a detection row.

- HELD rows stay informational (`waiting: { kind: "held", reason, reviewBy, lapsed }`); a lapsed one renders `HELD — REVIEW OVERDUE since <reviewBy>`.
- `OutdatedUpdater` gains `lapsed: Hold[]`. The detect job fills it from `lapsedHolds(await u.holds.read(root), today)` and files the task when any updater has an actionable row **or** a lapsed hold.
- The task text gets a "Holds to review" section per updater: each lapsed hold with its names, version/below, reason, issue and `reviewBy`, plus the two resolutions.

### 3. The runner refuses to upgrade past an unreviewed hold

`runUpgrade` reads every selected updater's holds first. If any is lapsed, the run ends at once with the new verdict **`holds-to-review`**: nothing planned, nothing touched, the receipt's `lapsedHolds` listing each (updater, file, hold). `upgradeThisWorktree` throws on it like `regressed`. The prompt allows a push only on `upgraded` / `partial`, so the agent cannot finish without resolving every lapsed hold in its worktree — and it gets the exact list as its to-do.

Rejected: a check failing on a lapsed hold. Checks gate every push; the day a hold lapses, every unrelated branch would fail. Date-dependent enforcement lives only in the upgrade path; the static checks only bound a `reviewBy` set too far out (which only the diff that sets it can trip).

Backstop: an unresolved lapsed hold re-files the upgrade task every detection cycle.

### 4. The prompt

New step before the upgrade: for each hold under "Holds to review", check whether its reason still stands (the issue, the upstream release notes, and if the suites do not exercise what broke, exercise it directly). Then:
- **Lift**: delete the hold (fix our code first if the bug is ours); the upgrade moves the release through the gates. If it regresses, re-add the hold with what was learned.
- **Renew**: keep it with a new `reviewBy` ≤ 90 days out and a reason stating what was checked and when.
Also delete any hold (lapsed or not) whose release a newer one has superseded.

## Files

- `updates/core/internal/{hold.ts, updater.ts, upgrade-prompt.ts}` (+ tests), `updates/cli/internal/{runner.ts, worktree-upgrade.ts}` (+ test), `updates/server/internal/detect-job.ts`
- `npm/core/internal/{plan.ts, coherence.ts}`, `npm/CLAUDE.md`
- `toolchain/core/internal/{tools.ts, versions.ts}`, `toolchain/check`, `mise/core/internal/mise-updater.ts`
- `uv-updater/core/internal/holds.ts`, `uv-updater/server/internal/uv-updater.ts`
- CLAUDE.md of deps, toolchain, uv-updater

## Verification

Unit tests: `holdState` / `heldBy` ignoring dates; runner ends `holds-to-review` with nothing planned when a hold is lapsed; prompt renders the review section and the overdue HELD row; `lockProblems` / `upgradeTarget` / `newestCpython` honour a lapsed hold. Then `./singularity build` (all checks) and `./singularity test` on the touched plugins.
