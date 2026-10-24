# Toolchain auto-upgrade

## Context

The tools in `mise.toml` (bun, go, tmux, rust) only change when someone upgrades them by hand, so they fall behind without anyone noticing. Bun sat on 1.3.13 from May to 2026-09-16. That version closes a finished child's extra fds a second time, which killed pooled Postgres sockets on main and froze live updates. Today the same drift is visible elsewhere: tmux is 3.6a (3.7c is out), rust is 1.96 (1.98.1 is out), go is 1.24.13 (1.27.1 is out), and mise itself is 2026.4.28 (2026.9.9 is out).

Writing `latest` does not fix this. mise resolves `latest` once at install time and then keeps using whatever is installed.

**What we want:** every tool runs its latest release, and gets there automatically. No update reaches main unless something has checked it for regressions. The fd double-close probe stays in place.

**Decisions from the user:**
- An auto-started agent task does the upgrade.
- There is no soak period.
- The agent is responsible for proving the upgrade works, and then pushes it itself.

## Design

### 1. Split what we want from what actually runs

- **`mise.toml` says what we want.** Every tool is `latest`: `bun`, `go`, `tmux` and `rust`. The comments explaining pins move out of this file (see minimum versions below).
- **A committed `mise.lock` records what actually runs.** It holds the exact version of each tool. Only `mise upgrade` rewrites it, so every version change shows up as a diff in git. A revert is an instant rollback, because old installs stay on disk (we never run `mise prune` automatically).
- **Minimum versions and holds live as data** in a new `plugins/toolchain/core` file. mise has no `>=` syntax, so these can't go in `mise.toml`. Each entry has a tool, a version, a reason, and optionally an upstream issue link:
  - `floors`: the lowest acceptable version. `bun >= 1.4.0` (fd double-close, oven-sh/bun#33828). `go >= 1.24` (older Go leaves out LC_UUID, and macOS 26 refuses to load the gateway binary).
  - `holds`: the agent adds one to skip a specific broken release, with the upstream issue as the reason. The next upgrade run tries the held release again once a newer release exists.
- **`[settings] min_version`** in `mise.toml` sets a minimum for mise itself. The upgrade command runs `mise self-update` first.
- **`gateway/go.mod`**: change `go 1.22` to `go 1.24`, to match the floor. The `go` directive is already a minimum.

**Phase 0 spike (must pass before anything else):** on mise 2026.9.x, confirm three things:
- (a) A `latest` request plus `mise.lock` resolves to the locked version.
- (b) The lock is read per worktree through shims. A worktree whose lock has a newer bun runs that bun, and main does not.
- (c) `mise upgrade` updates the lock.

If the lock does not behave this way, fall back to exact versions in `mise.toml`, rewritten by `mise upgrade --bump`. Everything below still applies; only the file that records exact versions changes.

### 2. Checks that keep the recorded versions honest

- **`bun-runtime`** (`plugins/framework/plugins/tooling/plugins/checks/plugins/bun-runtime/check/index.ts`):
  - Step 1 currently reads the exact pin from `mise.toml`. It will read bun's exact version from `mise.lock` instead.
  - Step 2 (the running Bun matches that version) and step 3 (the probe) stay as they are.
  - Update the explanatory text and its `CLAUDE.md` to match.
- **New check `toolchain:resolved`** in `plugins/toolchain/check/`, scoped to the tree like `bun-runtime`, and never cached. It fails when:
  - a tool in `mise.toml` has no exact version in `mise.lock`;
  - a running tool's version differs from the lock (`Bun.version`, `go version`, `tmux -V`, `rustc --version`, each run through `infra/spawn`);
  - a locked version is below its floor or equals a held version.

This keeps the protection `bun-runtime` gives today: the version in git is exactly what runs, and a regression fails loudly.

### 3. The upgrade command: `./equin toolchain upgrade`

The command is a CLI contribution from `plugins/toolchain/cli/`. It is fixed and repeatable, so the agent never improvises the gate. Steps:

1. `mise self-update`.
2. **Baseline.** On the current lock, run the full check suite and the test suite, and record each failure set.
3. `mise upgrade` (skipping holds). Then `mise install`, then install dependencies (a Bun change forces a full reinstall).
4. **Candidate.** Run the same check and test suites on the new versions.
5. **Compare.** A regression is a failure that appears only in the candidate run and happens again when retried once. A failure present in both runs was already there, and does not block the upgrade.
6. Write a receipt to `~/.singularity/worktrees/<wt>/toolchain-upgrade.json` with the old and new version of each tool, both failure sets, and a verdict. Print the verdict, and exit nonzero on a regression.

`--tool <name>` upgrades a single tool, so the agent can find which tool is at fault.

**Needed groundwork:** `./equin check` and `./equin test` currently print only human-readable lines. Add a structured results receipt next to `build-status.json`, written by the check runner (`plugins/framework/plugins/tooling/plugins/checks/core/runner.ts`) and the test CLI (`plugins/framework/plugins/cli/plugins/test/cli/run.ts`), listing failing check ids and failing test files and cases. It is written as a file, not added as a flag, so the "paths only, no flags" rule for `test` still holds. This is general-purpose infrastructure, not code specific to upgrades.

### 4. Detection: a daily job that files an auto-started task

`plugins/toolchain/server/`:
- A `defineJob` runs on main only, daily (`schedule: { cron: "0 6 * * *" }`), and `serial`. The pattern is from `plugins/debug/plugins/worktree-cleanup/server/internal/reap-job.ts`.
- It runs `mise outdated --json` (and checks for a newer mise) in the main checkout, using `spawnCaptured`, and ignores held versions.
- If anything is newer and no toolchain task is open, it creates one task:
  - `createTask` (`plugins/tasks/plugins/tasks-core/server`), under a new `toolchain` task category, the way `reports-investigation` uses `setTaskCategory`.
  - `setTaskAutoStart` (`plugins/tasks/plugins/auto-start/server`), which launches the agent in a fresh worktree through the existing `tasks.maybe-launch` → `createConversation` path.
- It never opens more than one task at a time. Several tools that fall behind are handled together in one upgrade, so each worktree pays for at most one dependency reinstall per run.

### 5. What the agent is told to do

The task description is fixed text owned by the toolchain plugin:
1. Run `./equin toolchain upgrade`.
2. **Green:** run `./equin build` for this worktree, confirm `build-status.json` is `ok`, then push with `./equin push -m "chore(toolchain): …"`, listing old→new versions. The push is explicitly allowed in this prompt.
3. **Regression:** use `--tool` to find the tool responsible. Push the tools that pass. For the failing release, look for or report the upstream issue, add a `hold` with the reason, and push that change. If a floor or a fix in our own code is the right answer, make that change instead, and prove it with the same command.
4. If the agent can't reach a clear result, raise a flag and do not push.

**`CLAUDE.md` change:** state that a toolchain-upgrade task carries standing permission to push when its receipt verdict is green. The general "never push unless instructed" rule stays.

### 6. How a change reaches the running system

- After a push, main rebuilds (the build runs the `tree` checks, so `bun-runtime` and `toolchain:resolved` run again on main). Backends pick up new versions through shims when they restart.
- A new Go reaches the running **gateway** only after `./equin start`. This is out of scope, and noted in the toolchain `CLAUDE.md`.
- Every worktree reinstalls dependencies on its next command after a Bun change. This is expected, and it is why upgrades are batched.

## Files

- `mise.toml`, new `mise.lock`, `gateway/go.mod`
- New plugin `plugins/toolchain/`: `core/` (floors and holds), `check/` (`toolchain:resolved`), `cli/` (`upgrade` command), `server/` (daily job, task category, task prompt), `CLAUDE.md`
- `plugins/framework/plugins/tooling/plugins/checks/plugins/bun-runtime/{check/index.ts,CLAUDE.md}`
- Check runner and test CLI: the results receipt
- Root `CLAUDE.md`: push permission for toolchain tasks
- `plugins/infra/plugins/launcher/CLAUDE.md`: update the note about pins to mention the lock

## Verification

1. Phase 0 spike, (a)–(c), run by hand in two worktrees.
2. `./equin check bun-runtime toolchain:resolved` passes on the lock. A hand-edited lock (wrong bun, bun below the floor, a held version) makes each one fail with a clear message.
3. Run `./equin toolchain upgrade` for real in this worktree. It should bring tmux, rust, go and mise up to date, write a receipt, and give a green verdict. Commit the resulting `mise.lock`. This first run is the initial catch-up.
4. Simulate a regression: add a check that fails only when `Bun.version` differs from the baseline, and confirm the verdict is a regression with a nonzero exit.
5. Trigger the detection job once by hand on this worktree's deploy, pointed at the worktree. Confirm it files exactly one auto-start task in the `toolchain` category, and that a second run files nothing.
6. `./equin test plugins/toolchain` covers the parsing of `mise outdated --json`, the floor and hold comparisons, and the failure-set comparison.
