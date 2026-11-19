# fsmonitor

git's builtin fsmonitor daemon, for the checkouts someone is using — and the
one owner of those daemons' lifecycle.

## Why

`git status` (edited-files, attempt-work, the file explorer, a build's tree
scan) looks at every file of a checkout: ~25.5k `lstat`s plus ~9.8k
directories through the untracked cache. The machine keeps file metadata for
only ~263k files (`kern.maxvnodes`, about 7 checkouts' worth), and builds and
installs churn through that in minutes, so a checkout left alone a few minutes
is cold: 1–5 s per read under load (edited-files 2.5–4.5 s, `file-explorer`
git status 5.1 s, task-1794782139-1a8h57). With fsmonitor, git asks the daemon
"what changed since this token?" and touches only those paths — a cold read
created 37 vnodes instead of 25.5k (measured), so its cost follows the change,
not the checkout or the cache.

## API (`server/`)

- `startCheckoutFsmonitor(path)` — `core.fsmonitor=true` in the checkout's OWN
  `config.worktree` (turning the repo's `extensions.worktreeConfig` on when
  off), or — for the MAIN worktree — in `.git/equin-fsmonitor.config`, read
  through an `includeIf "gitdir:<its .git>"` in the shared config (below); the
  shared config never gets `core.fsmonitor` itself, so no other checkout is
  on. Then the daemon, at `foreground`. Every git in the
  checkout — the agent's, our reads, a build's scans — then uses it.
- `ensureCheckoutFsmonitor(path, tier)` — make it current: started, restarted
  if throttled, its index token renewed if the daemon does not answer it.
- `stopCheckoutFsmonitor(path)` — unset the config FIRST (while set, any git
  there restarts the daemon), then stop the daemon.
- `reconcileCheckoutFsmonitors(checkouts, { orphanRoot, tier, stillOff })` —
  converge each checkout on `on` / `off` / `unknown` (left alone); `stillOff`
  is asked again just before a stop. Signals a daemon whose checkout's
  registration is gone. Failures are collected per checkout.
- `listRunningDaemons()` (one `ps`: pid → throttled), `listFsmonitorDaemons()`
  (+ one `lsof`: each daemon's socket names its git dir; best effort).

Callers: main's own checkout is turned on and kept on by the reconcile below
(`want: "on"`, always — D12; there is no setup step for it). `infra/worktree`'s `setupWorktree` starts it for every checkout it
writes, before the index refresh (so the refresh records the token), and
ensures it for an existing one (a resume) — a failure there is a result
(`fsmonitor: { kind: "failed" }`), never a failed launch.
`conversations/workspace/worktree`'s `worktree.fsmonitor-reconcile` (main
only) does the rest: on while the attempt is retained, off once not — when a
conversation closes, at main's start, and every 10 minutes. It decides
FINISHED checkouts only: one whose `worktree.prepare` run is open belongs to
that run's `setupWorktree` (which starts the fsmonitor itself, after the install), and one a
cut-off run left unfinished is discarded by the next — both are passed as
`unknown`. Racing the setup took `config.worktree.lock` twice, read an index
the tree write had not made yet, and (the one that could fail a launch) held
`index.lock` for a token publish while the setup's `git reset --hard` /
`git switch` needed it. A resume's prepare that starts just after the pass read
the open runs can still overlap it on a finished checkout; there every write
the setup makes to the fsmonitor is inside its non-fatal `fsmonitor` step.

## The token is the whole trick — and our reads never write it

git keeps the daemon's token in the index (`FSMN`,
`builtin:<n>.<pid>.<started>:<seq>`; `index-refresh`'s
`readIndexFsmonitorToken`) and asks "what changed since it?". No read of ours
writes the index (`GIT_OPTIONAL_LOCKS=0`), so every read asks with the token
of the last index write — fine while the daemon answers it (cost O(changes
since); the agent's own git writes renew it). A token the daemon did not issue
is answered "everything" (git's trivial response): a full scan on EVERY read
until the index is written again. That happens when the daemon died (reboot,
crash, killed with its starter's group — below), resynced after dropped
FSEvents (a new token under the same pid), or a git wrote the index without
fsmonitor. So the reconcile checks it each pass:

- index token's pid not a running, unthrottled daemon → start / restart, renew;
- otherwise one read-only `git diff-files --quiet` asks the daemon itself
  (trace2 `query/trivial-response:1` = stale) → renew.

Renewing = `refreshCheckoutIndex` (private copy whose `git status` records the
running daemon's token, published by compare-and-swap — safe beside an agent).

## Facts this rests on (measured, git 2.50.1 Apple)

- **git auto-starts the daemon** when the config is on and none listens — in
  the caller's process group and scheduling tier. Ours start it through
  `spawnCaptured` (own group, `foreground`), so a backend restart misses it.
  One auto-started by a background-tier git (an agent's, after a reboot) runs
  at darwinbg (`ps -o pri` 4) and starves under load: one read waited 28 s at
  load ~100, against 1–9 s without fsmonitor — restarted by the reconcile. One
  auto-started inside a group that gets killed dies with it — restarted too.
- It exits by itself when its checkout's directory is deleted; the orphan
  sweep only backs up a checkout moved away (the reap's rename to the trash).
- Its cwd is `$HOME`; only its socket (`<git dir>/fsmonitor--daemon.ipc`) names
  its checkout, and a socket path past 104 bytes is bound by a relative name
  `lsof` cannot map — so nothing but the orphan sweep relies on it.
- Each query writes a cookie under `<git dir>/fsmonitor--daemon/cookies/`;
  `checkout-watch` drops it and the socket as git-dir noise (else each read
  would trigger the next).
- ~12 MB RSS per daemon (4 MB idle), ~0 CPU.

## Main's checkout (D12)

On, through the same reconcile as the agent checkouts (`want: "on"`,
always): `core.fsmonitor` in `.git/equin-fsmonitor.config`, the daemon
started at `foreground`, its index token renewed when stale.

**Not `config.worktree`.** `git worktree add` copies the main worktree's
`config.worktree` into every checkout it makes (git ≥ 2.36; measured on
2.50.1), so every plain add (Claude Code's own `agent-*` worktrees, a
human's, another tool's) would come out with fsmonitor on and a daemon nobody
owns. `addCheckout` copies nothing, but it is not the only adder. So the key
lives in its own file, included by `[includeIf "gitdir:<repo>/.git"]`, which
matches the main worktree's git dir only (a linked checkout's is
`.git/worktrees/<id>`) and which no add copies. The test adds a worktree after
main is on and checks it stays off.

No opt-out yet: a pass rewrites the key if the human removes it. A renewal's
publish holds `index.lock` for one stat and one rename (`private-index`), so a
`git merge` / `checkout` in main landing in that window fails loudly
("index.lock: File exists"). The same protocol `checkout-watch` and the tree
hash already run there. What keeps it on: each pass (main's start, every 10 minutes, a
conversation closing) restarts a dead or throttled daemon and renews a stale
token; a pass that cannot fails `worktree.fsmonitor-reconcile`, which the jobs
audit files as a `job-attempt-failed` report naming main's path. Every push
merge rewrites main's index, which also renews the token.

Main's root holds every agent checkout (`.claude/worktrees/`, ignored by git
but not by FSEvents), so its daemon hears all their churn (a spare's
`bun install` included). Measured with a temporary daemon
(2026-11-19, ~450 checkouts):

| | token age | answer | `git status` (fsmonitor / plain) |
|---|---|---|---|
| load 8–31 | 2–4 min | 0.3–1.1 MB of paths, ~20 ms query | 0.17 / 0.68 s, 0.65 / 6.46 s, 0.26 / 0.65 s |
| load 31–58 (a build storm) | — | trivial: the daemon resynced 9–33 times in minutes (dropped FSEvents) | 3.30 / 2.84 s, 3.06 / 2.71 s |
| load 6–22, 18 min | — | no resync | — |

So a resync storm makes main's reads cost what they cost without fsmonitor
(a token the daemon did not issue is answered "everything"): slower than a
calm read, never wrong. The token stays stale until the next push or pass.
The daemon: 5–24 MB RSS, 0.1–0.9 CPU-s over its first 5–9 minutes.

Who reads it: the human's git, a push's merge, and code that asks
`getMainRepoRoot()` for a status — few. Main's BACKEND and its builds run
from a main slot (`main-slots`), and main's edited-files reads are of agent
checkouts; a traced daemon on the repo root answered ~3 queries in 18 minutes
besides the probe's own.

## Not here, on purpose

- **Spares** — the claim moves them; `setupWorktree` starts it at the final path.
- **Main slots** (`main-slots`) — where main's backend and builds actually
  read. Not yet: a build moves a free slot with `git checkout --force` under
  its exclusive lease, and a pass's token publish (`index.lock`) must not
  race it — the slot's own checkout is the place to start it, as
  `setupWorktree` does for an agent's.
- **Checkouts another backend minted** — main has no row to decide them by;
  the daemon ends with the checkout.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The one owner of git's builtin fsmonitor daemons for checkouts: startCheckoutFsmonitor (core.fsmonitor in the checkout's own config.worktree — the main worktree's in its own file, included for its git dir only, since git worktree add copies config.worktree — then the daemon, in a process group of its own so a backend restart does not stop it), ensureCheckoutFsmonitor (the same, plus renewing the index's fsmonitor token when the running daemon did not issue it — a stale token makes every read a full scan, since no read of ours writes the index), stopCheckoutFsmonitor, and reconcileCheckoutFsmonitors (converge every checkout on on / off as its caller says, and signal daemons whose checkout is gone). A git read in a live checkout then costs what changed, not the checkout's ~25k files, however cold the machine's file cache is.
- Server:
  - Uses:
    - `infra/git/index-refresh.CheckoutTier`
    - `infra/git/index-refresh.refreshCheckoutIndex`
    - `infra/paths.GIT`
    - `infra/paths.LSOF`
    - `infra/paths.PS`
  - Exports (types):
    - `FsmonitorCheckout`
    - `FsmonitorDaemon`
    - `FsmonitorEnsure`
    - `FsmonitorReconcile`
    - `FsmonitorStart`
    - `FsmonitorStop`
    - `FsmonitorToken`
    - `FsmonitorWant`
    - `RunningDaemon`
  - Exports (values):
    - `describeFsmonitorReconcile`
    - `ensureCheckoutFsmonitor`
    - `listFsmonitorDaemons`
    - `listRunningDaemons`
    - `reconcileCheckoutFsmonitors`
    - `startCheckoutFsmonitor`
    - `stopCheckoutFsmonitor`
- Cross-plugin:
  - Imported by:
    - `conversations/workspace/worktree`
    - `infra/worktree`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/lifecycle.ts`, `server/internal/daemons.ts` (debt)

<!-- AUTOGENERATED:END -->
