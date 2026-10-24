# Clone e2e harness traps: fix them at the source

## Context

Extending `plugins/upstream/e2e/clone-journey.ts` and `migration-journey.ts` (commit 7d3f223f5e, plan `research/2026-09-30-global-clone-migrations-published-set.md`) turned up five traps. The e2e works around each one by hand. Each is also a trap for any real user who clones the repo, and for any future test. The goal is to remove each trap where it lives, so the e2e loses its workarounds instead of accumulating more.

| # | Trap | Where it lives | e2e workaround today |
|---|------|----------------|----------------------|
| 1 | A local-path remote passes the `git push --dry-run` write probe | `infra/git/remotes` `publish-target.ts` `probeWriteAccess` | sets `singularity.publish.remote=none` by hand (migration-journey.ts:475) |
| 2 | Any repo's main checkout mints the namespace `singularity` | `infra/paths` `checkout-ref.ts` `checkoutRef` | parks HEAD on an unborn branch and runs every CLI call in `e2e-cj-<id>-*` linked worktrees |
| 3 | `push` is not hermetic: `migration-applies-clean` dry-runs against the real main DB | `database/migrations/check/index.ts` (hardcoded `MAIN_DB_NAME`) | hand-copies push's landing arms, regen and amend, and the ff (migration-journey.ts:288-336) |
| 4 | `SINGULARITY_DEPS_REEXEC` leaks to nested `./equin` invocations | `cli/bootstrap/reexec.ts` and `cli/bin/index.ts` | `delete env.SINGULARITY_DEPS_REEXEC` (migration-journey.ts:152) |
| 5 | A removed checkout's `~/.singularity/worktrees/<ns>/` lives forever | the reaper is attempt-row-driven, so nothing reclaims a non-task checkout | `removeDataDirs` in `finally` |
| + | A background op killed at 30 min | the Bash tool's background `timeout` now defaults to 1 800 000 ms. `background-ops` guard and root CLAUDE.md still say "background tasks have no timeout" | none |

The "+" row is the most urgent. From the guard's own op-log numbers, build p90 is 36.8 min and push p90 is 35.7 min. So the stale "no timeout" advice gets roughly 10% of every agent's builds and pushes killed, not only this e2e.

---

## 1. Filesystem remotes: the dry-run probe cannot answer, so do not ask it

**Recommendation:** add a transport classification and give filesystem remotes their own arm.

- In `remotes/core/internal/remote-url.ts`, add `remoteTransport(raw): "filesystem" | "network"`. It follows git's own rules:
  - `file://` is filesystem.
  - No `://` and no scp-like `host:` before the first `/` is a filesystem path.
  - Everything else is network.
  - It sits next to `normalizeRepoUrl`, which already treats paths as opaque.
- In `compute()` (`publish-target.ts`), a filesystem remote returns `{kind:"local", reason:{kind:"filesystem-remote", url}}` without probing and without caching. The answer comes from the URL, so it is deterministic and costs nothing.
  - `PublishTarget`'s reason union gains the arm, so tsc drives every consumer, including push's printed "landing locally because…".
- Remove the "What it cannot tell you" caveat in the remotes CLAUDE.md about filesystem remotes. Replace it with the new rule. `recordPushRejection` stays for forges that lose access later.
- **Decided:** a filesystem remote never publishes, and there is no opt-in until someone needs one.
- e2e: drop the `publish.remote=none` lines. clone-journey's `origin`→`upstream` rename stays, because it models a real clone's layout.

## 2. Only the installed repo's main checkout is `singularity`

The data root (`~/.singularity`) serves exactly one repo; this is the single-instance ADR. Today, "is this the main checkout?" is asked of whichever repo the cwd is in.

- **Record the installed repo.** Add `installedRepo()` in `infra/paths`: `state/install/repo.json`, holding `{ gitCommonDir }` (realpath).
  - `start`'s `prepareGateway` writes it, since it already resolves `repoRoot` there, as does the release launcher's install path.
  - Backfill when the record is absent: derive it once from `database.json`'s recorded `services[].start` path, which sits inside the installed repo, then write the record.
  - With neither present (a fresh machine before `start`), there is no installed repo, so today's behavior applies.
- **`checkoutRef(root)`** (`paths/core/internal/checkout-ref.ts`) returns `{kind:"main"}` only when the root is its repo's main checkout AND the repo's common dir equals the installed one.
  - A foreign repo's main checkout becomes `{kind:"worktree", name: basename(root)}`, which is exactly how every other non-main checkout is named. All namespace, data-dir and op-slug derivations go through this function, so they follow with no call-site changes.
  - **Decided:** if that basename is the reserved `singularity`, throw a named error: "second clone at <root> would collide with the installed instance; rename the directory or use a linked worktree". It is loud, and it has one fix.
- The op-status banner keys on the conversation worktree's basename (`op-lines.ts slugOf`). It already agrees with this rule for foreign checkouts. No change is needed there.
- e2e: drop the unborn-branch parking and the `e2e-cj-*` linked worktrees. CLI calls run in the temp repos' own main checkouts, whose temp-dir basenames are unique.

## 3. `push` runs for real in the e2e

Root cause: `migration-applies-clean` dry-runs a checkout's pending migrations against `MAIN_DB_NAME`, the canonical main's live DB. For a foreign clone that is simply the wrong database. With #2 in place, the clone's pending delta is measured against a history it does not share.

- **Target the checkout's own main DB.** The check resolves the DB of `namespaceFor(MAIN, checkoutRef(mainRoot))`. For the installed repo that is still `singularity`, so there is no behavior change.
- **A main that was never deployed has no live data to break.** When the target DB does not exist AND the repo is not the installed one, replay onto a throwaway DB instead. The throwaway DB is built from main's published migrations via the `db-test-fixture` primitive, then the pending delta is dry-run on it. The result says `schema-only (no deployed main for this repo)` so the mode is visible.
  - The installed repo's missing DB stays a loud "cannot verify", as it is today.
- `fork-schema-drift` gets the same audit: it should compare against the checkout's own main worktree, not the canonical one.
- The push mutex is host-wide under the data root. For a foreign repo that means contention with real pushes, which is correct but slower. Leave it.
- e2e: delete `landingPrep` and `fastForwardMain`, plus clone-journey's inline copy. Call `./equin push -m …` in the clone's worktree. The emulation-drift trap disappears because there is no emulation.
  - **Cost:** the full `--scope tree` check pass runs 2–4 times per journey, adding ~minutes each. This is traded against drift. See the open question below.

**Decided: real push.** A shared `planLanding` was rejected because the normalize step would still be emulated.

**Blast-radius guards:** by construction, the clone's push can only reach temp repos. Two checks make that verified rather than assumed:

- **In `push`:** before `git merge --ff-only` in the main worktree, assert that `git rev-parse --git-common-dir` of that worktree equals the invoking checkout's. If it doesn't, throw a named error. A push can then never land on a repo other than the one it was run from, whatever an inherited `GIT_DIR` or a cached root says.
- **In the e2e:**
  - Before each push, assert that the clone's main root and common dir sit under the temp dir.
  - Record this checkout's `refs/heads/main` and `refs/remotes/origin/main` at start.
  - At the end (in `finally` too), fail loudly if any commit in `<start>..main` or `<start>..origin/main` came from this run: its message carries the run's unique id, or it touches the e2e probe files (`tables-e2e-*.ts`). This is a provenance check, not "the ref didn't move": other agents legitimately advance the real `main` during a 25-minute run.

## 4. The re-exec budget belongs to one invocation

`REEXEC_ENV` is a counter for one user invocation's re-exec chain. Descendants inherit it through `process.env` and start with a spent or partial budget.

- In `cli/bin/index.ts`, before `ensureDeps`, call `takeReexecBudget()`, a new export from `reexec.ts`. It reads the counter AND deletes it from `process.env`.
  - `reexecAfterInstall` takes the prior count as an argument instead of reading env.
  - The only process that ever sees the variable is the direct re-exec child. Anything that process spawns (`run` → e2e → `./equin …`, `build` → `check` subprocess) starts fresh.
- Unit test in `reexec.test.ts`: after taking the budget, the env no longer carries the counter, and a spawned child's env lacks it.
- The `runtime-env.ts` declaration stays, with its text updated to "consumed by the bootstrap; never reaches a descendant".
- e2e: drop the `delete`.

## 5. Orphaned data dirs are swept, not hand-deleted

- **Provenance stamp.** Find or introduce the one funnel that creates `worktreeDataDir(ns)` (`infra/paths`). It writes `checkout.json` holding `{ root }` on creation.
- **Sweep.** Add a daily main-only job, `paths.sweep-orphan-data-dirs` (`defineJob` with a schedule, no timer). It removes a data dir when all of the following hold:
  - its stamped root no longer exists;
  - it is not a live attempt's worktree;
  - it holds no live op marker (flock probe, as `probeWorktreeOp` already does);
  - it is older than a grace period (24 h).
  - Each removal files an info report, following `db-test-fixture/sweep`'s rule that a destructive sweep is never silent.
- Dirs without a stamp (legacy) are left alone. The reaper's age policy already covers task worktrees.
- e2e: drop `removeDataDirs`. Temp checkouts are swept after the grace period.

## + Background timeout

- `background-ops` guard (`tooling/guards/core/guards/background-ops.ts`):
  - A long op with `run_in_background: true` must also pass `timeout: 7200000`, the maximum. Otherwise the call is blocked with that exact fix.
  - `./equin run <…/e2e/…>` joins `LONG_OPS`, since e2e scripts are ops with a CPU grant.
  - Fix the docblock's "has no timeout" claim; the measured 125–823 min lifetimes predate the harness cap.
- Root CLAUDE.md, Agent Workflow step 2: replace "Background tasks have no timeout" with the `timeout: 7200000` rule. The e2e-harness CLAUDE.md gets the same note for long e2e scripts.
- 2 h can still lose to a long grant queue. `./equin await e2e` (the op kind already exists in `OP_KIND_IDS`, to be verified) is the recovery path, and it is documented there.

---

## Critical files

- `plugins/infra/plugins/git/plugins/remotes/core/internal/{remote-url,publish-target}.ts`, `remotes/CLAUDE.md`
- `plugins/infra/plugins/paths/core/internal/{checkout-ref,paths}.ts` (+ install record, data-dir stamp, sweep job in `paths/server`)
- `plugins/framework/plugins/cli/plugins/start/cli/run.ts` (write install record)
- `plugins/database/plugins/migrations/check/{index,fork-schema-drift}.ts`
- `plugins/framework/plugins/cli/plugins/bootstrap/cli/reexec.ts`, `cli/bin/index.ts`, `infra/launcher/core/internal/runtime-env.ts`
- `plugins/framework/plugins/tooling/plugins/guards/core/guards/background-ops.ts`, root `CLAUDE.md`, e2e-harness `CLAUDE.md`
- `plugins/upstream/e2e/{clone-journey,migration-journey}.ts` (remove every workaround above)

Changes under `plugins/framework/` (cli bootstrap, guards) need the user's approval, per framework/CLAUDE.md. Asking for this plan's approval covers it.

## Order

These are independent commits in one branch: + (guard and doc), 4, 1, 2, 5, 3, then the e2e simplification last. The e2e goes last because it proves every fix at once: each deleted workaround that would still be needed fails the journey.

## Verification

- Unit tests:
  - `remoteTransport` table: file://, abs/rel paths, scp, https, ssh://.
  - `checkoutRef` with and without an install record, a foreign main, and the reserved-name collision.
  - `takeReexecBudget`.
  - Sweep predicate: stamp missing, root present, live marker, grace.
  - Guard: background without timeout is blocked, `run e2e/` is detected.
  - `./equin test plugins/infra/plugins/git/plugins/remotes plugins/infra/plugins/paths plugins/framework/plugins/cli/plugins/bootstrap plugins/framework/plugins/tooling/plugins/guards`
- `./equin check migration-applies-clean` in this worktree with a migration change present: it still targets `singularity`, unchanged.
- The e2e itself, with every workaround removed: `./equin run plugins/upstream/e2e/clone-journey.ts`, background, `timeout: 7200000`. Confirm:
  - nothing appears on main's op banner;
  - no dir remains under `~/.singularity/worktrees/` named after the temp repos, once the sweep has run (trigger the job manually);
  - the clone's push lands locally with reason `filesystem-remote`.
- `./equin build`, then confirm main's own namespace is still `singularity` (install record backfilled from `database.json`).

---

## As implemented (deviations from the plan above)

- **Trap 2: no new install record.** "The installed repository" is read from what already exists: the `server` path in `worktrees/singularity/spec.json`, written by the main build (`mainNamespaceOwner` in `paths/core/internal/checkout-deploys.ts`).
  - A spec that is absent, or that names a checkout no longer on disk, means unclaimed. The asking main checkout then takes `singularity`.
  - A spec that exists but cannot be read throws. It never reads as unclaimed.
- **Trap 5: the sweep is a pass of the existing hourly worktree reaper** (`debug/worktree-cleanup` `collectReapable`), not a new job.
  - The stamp is `worktrees/<ns>/checkout.json`. It is written by `actAsCheckoutNamespace(root)`, which the three op entry points use instead of `checkoutNamespace`: direct ops, `push` and `build`.
  - A namespace is reclaimed through `reapAttempt(ns)` (its DB, config dir and registry dir) when all of these hold:
    - its name is not an attempt id;
    - it has no composition marker;
    - it is not `singularity`;
    - its stamped checkout is gone;
    - its stamp is older than 24 h.
- **Trap 3: the push mutex is per repository** (user decision): `pushLockFor`.
  - The installed repository keeps the host `push` pool.
  - Any other repository locks in `<git-common-dir>/singularity-locks/push/`, via a new `RepoLockDir` slot kind in `packages/host-semaphore`.
  - The schema-only dry-run creates and drops its scratch database over a direct connection to the `postgres` maintenance DB. It cannot use `database/admin`, whose pool throws at import in a check subprocess.
  - The name comes from `mintTestDbName`, so the test-db sweep is the backstop.
- **"+" (timeout): a rewrite guard, `background-timeout`, not a deny.** Every backgrounded `./equin …` call gets `timeout: 7200000`. There is no list of long subcommands, so an e2e `run` needs no path predicate.
- **clone-journey's inline landing stays.** That fixture is a two-file text repo with no `./equin` CLI, so there is no push to call. Push's real landing is now covered by the migration journey.
