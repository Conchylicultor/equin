# Clone-user git journey: publishing as a probed capability, upstream as a report

> Plan, 2026-09-20. Step 3 of the "Installable by others" page. Scope is the
> **git journey only** — no install script, no onboarding, no `doctor` command.

## Context

Someone who is not the author clones this repo and starts using it. Everything
local already works for them: agent worktrees branch off the local `main`
(`plugins/infra/plugins/worktree/server/internal/worktree.ts:435`), main's
auto-build fires on the local `refs/heads/main` file moving
(`git-watcher/server/internal/watcher.ts:100-129` →
`plugins/build/server/index.ts:26-31`), and the pushes ledger and attempt-work
read local `main` only. No network anywhere.

The one exception is `./equin push`, which is also the only place in the
repo that does network git at all. It does three remote calls
(`plugins/framework/plugins/cli/plugins/push/cli/run.ts`):

| step | line | effect on a user with no write access |
| --- | --- | --- |
| `git fetch origin main` + `git merge --ff-only origin/main` | 476, 480 | **silently pulls the author's commits into the user's main on every push**, and the moment the user's own main has diverged, the fast-forward fails and push is broken for good |
| `git push --force-with-lease -u origin <branch>` | 586 | fails with permission denied, after the whole check pass |
| `git push` (main) | 606 | fails |

So a clone user's push works by accident until either side moves, then stops.
And there is no way to receive upstream changes at all.

Three things this plan adds:

1. Push publishes only when this checkout may write to its remote, and skips all
   three remote steps otherwise. Local `main` becomes the user's own trunk.
2. The repo the clone came from is recognised as **upstream**, and new commits
   there surface as a report plus the bell — never an automatic change.
3. Push can land a branch that merged upstream, without flattening the merge.

Non-goals, already tracked as steps 2/2b/3 on the plan page: the install script,
a prerequisite `doctor`, onboarding, the author's personal plugins shipping to
everyone.

## The model

- **Local `main` is the trunk.** Push always commits, rebases, checks, and
  fast-forwards local `main`; main then rebuilds itself. That half is offline
  and unchanged.
- **Publishing is a capability, not a mode.** Only the remote can say whether
  this checkout may write to it, so ask it once and record the answer. There is
  no author/user flag to set, and nothing to get wrong by cloning by hand.
- **Upstream is the remote we can read but not write.** A clone has one remote
  (upstream). A fork has two. The author has one, writable, and therefore no
  upstream and no update reports.

## 1. New plugin: `plugins/infra/plugins/git/plugins/remotes`

Sits under the existing `git` umbrella ("has git state moved, and must I read it
again?"). `core/` only, Node-only like `spawn/core` — both the CLI (push) and
the server (the daily job) import it, so the classification has one definition.

```ts
// core/index.ts
export type PublishTarget =
  | { kind: "publish"; remote: string; url: string }
  | { kind: "local"; reason: "no-remote" | "read-only" };

export type UpstreamRemote =
  | { kind: "upstream"; remote: string; url: string }
  | { kind: "none"; reason: "is-publisher" | "no-remote" };

export function resolvePublishTarget(root: string): Promise<PublishTarget>;
export function resolveUpstreamRemote(root: string): Promise<UpstreamRemote>;
export const CANONICAL_REPO_URL = "https://github.com/Conchylicultor/singularity";
```

Discriminated results, not `null` — "we could not publish" is a state with a
reason the caller prints, never an absorbable empty value.

**The probe.** `git push --dry-run <remote> main` contacts the remote and asks
for `receive-pack`, which is exactly the write-permission question, and writes
nothing. Run only when the cache is cold, so the normal push pays nothing.

**The cache** goes in `.git/config` — per clone, untracked, shared by every
worktree of that clone, readable with no server. Same tier and the same shape as
`core.hooksPath`, which `build` already self-heals
(`plugins/framework/plugins/cli/plugins/build/cli/run.ts:155-178`), and as the
merge drivers written by
`plugins/framework/plugins/cli/plugins/git-artifacts/cli/register-merge-drivers.ts:33-56`
(`gitConfigGet` / `gitConfigSet` there are the helpers to reuse — lift them into
this plugin rather than copy them).

```
singularity.publish.remote = origin | none
singularity.publish.url    = <the URL that answer was probed for>
```

Re-probe when the recorded URL no longer matches the remote's current URL (the
user added their fork, or re-pointed origin), and when a real push is rejected
for permissions — that rejection is newer evidence than the cache, so record it
and say so.

It is a cache of a measurement, not a setting: this is why it is not a config_v2
value. A user-editable "may I publish" field would be a claim the remote can
contradict.

**Upstream resolution**, from the same facts:
- a remote named `upstream` → that one;
- else the publish target is `local` → origin **is** upstream;
- else (publisher whose URL is not `CANONICAL_REPO_URL`, i.e. a fork) → add
  `upstream` pointing at `CANONICAL_REPO_URL` and use it;
- else (the author) → `{ kind: "none", reason: "is-publisher" }`.

`CANONICAL_REPO_URL` also belongs in `CITATION.cff:11`; the plan keeps the
constant here and leaves deduplicating the two to whoever adds the README.

## 2. `push` asks before it reaches the network

`plugins/framework/plugins/cli/plugins/push/cli/run.ts`, both the worktree path
and `--from-main`:

- Resolve the publish target once, before the push lock.
- `kind: "publish"` → today's flow, unchanged.
- `kind: "local"` → skip `fetch` + `merge --ff-only origin/main` (476-480), skip
  `push --force-with-lease` (586), skip `git push` (606). Everything else — the
  lock, the rebase onto local main, `installRebasedDeps`, the normalize, the
  tree-scoped checks, the fast-forward of main — runs exactly as now.
- Print which mode it took and why, on one line, so it is never a silent
  difference: `Local only (origin is read-only) — main advanced, nothing pushed.`
- The profiler's `fetch` / `push-branch` / `push-main` steps are simply not
  started in local mode; `plugins/stats/plugins/pushes` reads missing steps as
  zero already.

`--from-main` carries a second, pre-existing hazard worth fixing in the same
pass: it rebases the checkout's own `main` **before** its final push, so a failed
push leaves local main advanced and already rebuilding. In local mode there is no
final push, so the hazard disappears; for a publisher, move the rebase after a
`git push --dry-run` succeeds, or accept it explicitly in a comment.

## 3. `push` lands a merge without flattening it

The update agent's branch is `main` + a merge commit of `upstream/main`. Today's
`git rebase main --exec <stamp>` (488-498) would flatten that merge into a
replay of every upstream commit.

After the ff of local `main`, ask git whether the branch already contains it:

```
git merge-base --is-ancestor main HEAD
  yes -> no rebase at all; stamp the tip with `git commit --amend --trailer …`
  no  -> git rebase main --exec <stamp>                   # unchanged
```

**Corrected 2026-09-20, measured.** The first version of this section used
`git rebase --rebase-merges`. It preserves the topology and `--exec` does stamp
every replayed commit — but it **rewrites the merged-in upstream commits**:
`8a9d381 "upstream: one"` came back as `580dcd8`, and upstream's own sha was no
longer an ancestor of HEAD. Upstream's commits would land in the user's history
under identities upstream never had, so the next
`./equin upstream merge` would have a merge base *below* them, re-present
changes already merged, and bring back every conflict resolved last time —
which is the exact failure merging instead of rebasing was chosen to avoid.

Landing by fast-forward with no rebase keeps upstream's real commits. Measured
on the same throwaway repos: after the update landed, upstream's sha was still
an ancestor of main, and the next update's merge base was upstream's own commit,
so only the genuinely-new upstream change conflicted.

The cost is stated rather than hidden: on such a branch only the tip carries the
`Singularity-Push` trailer, so the ledger groups the tip alone. That is the
right trade against rewriting another repository's commits.

One hole to close loudly: if the branch holds merge commits
(`git rev-list --merges main..HEAD`) but main is **not** an ancestor — main moved
while the update branch sat — push must refuse and say to run `git merge main`
in the worktree, never fall through to the flattening rebase.

A branch that already contains main never needed a flattening rebase anyway: the
rebase exists only to make step 6's ff-merge possible, which is already true.

## 4. `./equin upstream status | merge`

New CLI plugin `plugins/framework/plugins/cli/plugins/upstream/`, declaration in
`cli/index.ts` and body behind the lazy `import()` like every other command.

- `status` — resolve upstream, `git fetch <upstream> main`, print how many
  commits `main..upstream/main` holds and their subjects. No upstream ⇒ say so
  and exit 0.
- `merge` — refuses on the main checkout (`getWorktreeRoot() === getMainRepoRoot()`,
  as `plugins/toolchain/cli/internal/upgrade.ts:73-74` does). Fetches upstream and
  runs `git merge upstream/main` on the current worktree branch. Conflicts are
  left in the tree for the agent, with the printed instruction that generated
  files resolve themselves (the `.gitattributes` merge drivers take the upstream
  side and `push`'s normalize re-derives them) and that a conflicted migration
  is the one thing to stop and report on.

The command exists so the mechanical half is one tested path instead of prose an
agent re-derives each time — the same reason `toolchain upgrade` is a command.

`CLAUDE.md`'s "always rebase, never merge" needs one carve-out sentence: merging
`upstream/main` into an update branch is the one sanctioned merge, because
rebasing the user's trunk onto upstream would replay their whole history on every
update and rewrite `main` under every open worktree.

## 5. New plugin `plugins/upstream`: the daily check, as a report

Server-only, modelled on `plugins/toolchain/server` — with the difference the
user asked for: **it files no task.**

```ts
// server/internal/detect-job.ts
export const detectUpstreamJob = defineJob({
  name: "upstream.detect-updates",
  hold: "minutes",
  inProcess: "One fetch plus one rev-list; a restart just repeats it tomorrow.",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  schedule: { cron: "0 5 * * *" },   // perWorktree unset ⇒ main only
  run: async () => { /* resolve upstream; none ⇒ return; fetch; count; record */ },
});
```

The signal is a **report kind**, copying the shape of
`plugins/backup/server/internal/report-kind.ts`:

- `kind: "upstream-updates-available"`, `variant: "info"`.
- `fingerprint` is a **constant**, not the upstream sha — one rolling row whose
  count rises, never a new row per commit (a sha fingerprint would trip the
  cross-fingerprint fan-out ceiling described in `plugins/reports/CLAUDE.md`).
- `notifCooldownMs` about a week, so a standing "you are 40 commits behind"
  re-rings occasionally instead of being read once and never seen again.
- `data` carries the commit count, the newest sha, and the newest subjects.

`renderTask(row)` is where the update instructions live. Reports already file an
investigation task **on demand** (`plugins/tasks/plugins/reports-investigation`),
so the user gets a report in the bell and an Investigate button that mints the
task with this text when they want it:

1. `./equin upstream merge` in this worktree.
2. Resolve conflicts. Generated files re-derive themselves; a conflicted
   migration means stop and report.
3. `./equin build` in the background; confirm `build-status.json` is `ok`.
4. Open the worktree URL and check the app still works.
5. Report what changed and wait — **do not push**; the user lands it.

Write it as a pure string builder in its own module, like
`plugins/toolchain/server/internal/upgrade-prompt.ts`, so it is readable and
testable on its own.

## Files

| file | change |
| --- | --- |
| `plugins/infra/plugins/git/plugins/remotes/{core/index.ts,CLAUDE.md,package.json}` | new: probe, cache, classification |
| `plugins/framework/plugins/cli/plugins/push/cli/run.ts` | gate the three remote steps; merge-preserving rebase arm |
| `plugins/framework/plugins/cli/plugins/upstream/**` | new command: `status`, `merge` |
| `plugins/upstream/{server/index.ts,server/internal/{detect-job,report-kind,merge-prompt}.ts,core/index.ts}` | new: daily job + report kind |
| `plugins/framework/plugins/cli/plugins/git-artifacts/cli/register-merge-drivers.ts` | lift `gitConfigGet`/`gitConfigSet` into the new plugin and import them here |
| `CLAUDE.md`, `plugins/framework/plugins/cli/plugins/push/CLAUDE.md`, `docs/setup.md` | local-only push, the one sanctioned merge, the upstream flow |

## Verification

All of it is reproducible on this one machine — no second computer, which is the
open question on the plan page for step 1.

1. **A read-only remote, locally.** `git clone --bare` this repo to
   `/tmp/upstream.git`, `git clone /tmp/upstream.git /tmp/clone`, then
   `chmod -R a-w /tmp/upstream.git`. Pushing from `/tmp/clone` now fails exactly
   as a GitHub permission denial does.
   - `resolvePublishTarget` returns `{kind:"local",reason:"read-only"}` and writes
     the git-config cache once; a second call does no network.
   - `./equin push -m "x"` in a worktree of `/tmp/clone` advances local
     `main`, prints the local-only line, and leaves `/tmp/upstream.git` untouched.
   - Restore write permission, re-point the URL, and confirm the cache re-probes.
2. **The author's path is unchanged.** In this checkout, `resolvePublishTarget`
   returns `{kind:"publish",remote:"origin"}` from cache, and a normal push still
   fetches, pushes the branch, and pushes main.
3. **Merge topology and upstream identity.** In `/tmp/clone`: commit locally on
   main, add a commit to `/tmp/upstream.git`, then in a worktree run
   `./equin upstream merge` followed by `./equin push`. Assert the
   merge commit survives with both parents, the tip carries a `Singularity-Push`
   trailer, and — the one that decided the design —
   `git merge-base --is-ancestor <upstream sha> main` still passes. Then move
   upstream again and take a second update: its merge base must be upstream's own
   commit, so nothing already merged is re-presented. (Done for the mechanism on
   throwaway repos; redo it through the real commands.)
4. **Migrations across an update** — the risk with the least evidence today. Give
   the clone a local migration, give `/tmp/upstream.git` a different one, merge,
   and run the build. The runner keys applied migrations by hash
   (`plugins/database/plugins/migrations/server/internal/runner.ts:51-82`), so an
   upstream migration with an older timestamp still applies rather than being
   skipped — confirm that, and confirm the post-merge regenerate does not rename
   the user's already-applied migration into a new hash that would re-run it.
   If it does, that is a second plan, not a patch here.
5. **The report.** Enqueue `upstream.detect-updates` by hand against the clone
   and check: one row in Debug → Reports, the bell rings, a second run bumps the
   count instead of minting a row, and Investigate files a task carrying the
   merge instructions. `query_db` against the clone's DB confirms the single row.
6. `./equin check` and `./equin test plugins/infra/plugins/git`.

## Risks

- **Migration ordering across an update** — verification 4. The hash ledger makes
  the obvious failure (silently skipping an older upstream migration) impossible,
  but two sides altering one table is still a real conflict a person must read.
- **`--rebase-merges` with `--exec`** — verification 3, with a named fallback.
- **The report never clears itself.** Once the user merges, tomorrow's job records
  nothing, but the existing row stays until retention drops it. Acceptable to
  start; if it reads as stale, the job should resolve the row when the count
  reaches zero.
- **The author's personal plugins ride along with every update.** Out of scope
  here, and the reason step 2b exists.
- **The no-rebase arm is broader than its reason.** It fires for any branch that
  contains `main`, including a feature branch where someone merged `main` in
  instead of rebasing. There the lost push trailers buy nothing, since no
  upstream commits are at stake. Narrowing it would mean asking whether a merge's
  second parent is reachable from an upstream remote-tracking ref — more
  machinery than the gap is worth today, and such a branch is already against the
  rebase rule. Revisit if the ledger gap ever shows up in practice.
