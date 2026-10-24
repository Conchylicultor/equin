# Baseline run 1 — where a from-scratch install stops (2026-09-18)

Track: "Installable by others" (page `block-cc11355f-6bc1-48a5-b4b6-e32b2aee6932`), step 1.
Plan: [`2026-09-17-global-clean-install-baseline.md`](./2026-09-17-global-clean-install-baseline.md).

> This belongs on the track page as a sub-page, per the track instructions. It is
> here because `edit_page` refuses every edit to that page: "Reading it out and
> applying it back completely unchanged would itself create 1 block … This is a
> bug in the page's markdown projection". Move it once that is fixed.

## What was run

A throwaway macOS 26.6.2 virtual machine (Tart, `macos-tahoe-vanilla`, 6 cores,
12 GB, 90 GB disk), created fresh from the base image. No Homebrew, no Xcode
command-line tools, no Bun, Go, Postgres, mise or Claude Code. The only
instructions followed were `docs/setup.md`, in order, starting from
`git clone https://github.com/Conchylicultor/singularity`.

Harness: `sidequests/clean-install/` (`run.sh`, `steps.sh`, `CLAUDE.md`).
Logs and the per-step summary: `~/.singularity-clean-install/si-clean-20260918-021701/`.

The author's own machine was untouched: the main gateway on port 9000 was the
same process before and after (pid 98066), still answering 200, and nothing
under the author's `~/.singularity` was written.

## Result

**A new user cannot finish the install today.** They get stuck at the database,
with no discoverable way forward. Every path the app itself suggests is a dead
end.

The run did eventually deploy the app, but only after a step no user could take:
the harness applied the 255 migration SQL files by hand. That step exists so one
run could also show what breaks *after* the wall. Everything below step 19 is
therefore "what a user would hit"; step 19 onwards is "what is waiting behind
it".

Checkpoints:

| Checkpoint | Reached | Time to reach |
| --- | --- | --- |
| 1. Tools installed | yes | 1m 54s |
| 2. Gateway running | yes | 2m 24s |
| 3. App deployed and rendering | only past the wall | 9m 32s total |
| 4. An agent runs | no — Claude Code is not installed and nothing mentions it | — |

Total of every step's last attempt: 9m 32s. That is machine time on a fast
connection; it excludes the time a person spends working out what to do at each
failure, which is where the real cost is.

## What happened, in order

Failures are marked ✗. "Fix found" says where a user could have found the fix.

| # | Step | Result | Time | Fix found |
| --- | --- | --- | --- | --- |
| 1 | record guest state | ok | 0s | — |
| 2 | `git clone …` | ✗ exit 1 | 0s | nowhere in the repo |
| 3 | install Xcode command-line tools | ok | 66s | Apple's own dialog |
| 4 | `git clone …` again | ok | 6s | — |
| 5 | `brew install oven-sh/bun/bun` | ✗ exit 127 | 0s | nowhere in the repo |
| 6 | install Homebrew | ok | 15s | Homebrew's site |
| 7 | `brew install oven-sh/bun/bun` | ok | 6s | — |
| 8 | `brew install go` | ok | 6s | — |
| 9 | `brew install postgresql@18` | ok | 15s | — |
| 10 | `git config core.hooksPath .githooks` | ok | 0s | — |
| 11 | `./equin start` | ok | 30s | — |
| 12 | `./equin build --allow-main` | ✗ exit 1 | 62s | the error names `./equin db fork` |
| 13 | `./equin db fork` | ✗ exit 1 | 0s | dead end |
| 14 | install mise, `mise install` (runs the repo's `setup`) | ok, but skipped its job | 16s | `mise.toml`, which no doc points to |
| 15 | `createdb` + `./equin apply-migrations` | ✗ exit 1 | 0s | dead end |
| 16 | build again | ✗ exit 1 | 2s | — |
| 17 | `./equin start --force` | ok, no effect | 22s | a guess |
| 18 | build again | ✗ exit 1 | 2s | **this is where a real install ends** |
| 19 | apply 255 migrations by hand (harness only) | ok | 6s | not user-reachable |
| 20 | build again | ✗ exit 1 | 289s | the check's own message names `tmux` |
| 21 | `brew install tmux` | ok | 3s | that message |
| 22 | build again | ✗ exit 1 | 11s | the same check now names `rustc` |
| 23 | put mise's tools on the PATH | ok | 0s | mise's own docs |
| 24 | build again | **ok — deployed** | 10s | — |
| 25 | `curl http://equin.localhost:9000/` | ok, 200 | 0s | — |
| 26 | screenshot the running app | ok, renders | 5s | — |
| 27 | is Claude Code installed? | missing | 0s | nothing mentions it |
| 28 | reboot the machine | app gone until `./equin start` is re-run by hand | — | nothing mentions it |

## Blockers, ready to file

Each of these is one task. Ordered by how early a user hits it.

**1. `git clone` fails on a clean Mac — no Xcode command-line tools.**
`docs/setup.md` never mentions them. On a desktop the failure pops an install
dialog; over a remote shell there is nobody to click it, and the command just
exits 1.
```
xcode-select: note: No developer tools were found, requesting install.
```

**2. The prerequisite table assumes Homebrew already exists.**
All three install commands start with `brew`, and nothing says to install it.
```
bash: line 1: brew: command not found
```

**3. Nothing creates the base database, so the first build fails.**
The build waits 60s for a database that no documented step ever creates.
```
ERROR: no database for "singularity" and no fork in flight after 60s.
```

**4. The build's own advice cannot be followed — it is circular.**
The error says to run `./equin db fork`. That command asks a *running
backend* which tables to leave out, and no backend can run until the app is
built. On a fresh install there is nothing to ask.
```
error: Could not read the fork exclusion set from any running backend:
  http://equin.localhost:9000/api/db/fork-exclusions → 404
Start equin and retry …
```

**5. The repo's own setup task silently does nothing on a clean machine.**
`mise run setup` is the only thing that creates the base database. It probes a
system Postgres on port 5432, while the app's own Postgres listens on a socket
on 5433 — so on a machine set up the documented way it always skips.
```
setup: Postgres is not running — skipping (start it and re-run 'mise run setup').
```
It also exits 0, so nothing downstream notices.

**6. `./equin apply-migrations` is broken — it crashes on its first log line.**
This is the command that exists specifically for the fresh-clone case, and the
one `mise run setup` calls. It crashes the same way with or without
`--namespace`. With it broken, there is no way to seed the database at all.
```
error: [runtime-identity] this process has not declared a runtime namespace.
    at runtimeNamespace (…/runtime-identity.ts:62:15)
    at logsDir (…/log-channels/server/internal/persist.ts:27:31)
    at runMigrations (…/migrations/server/internal/runner.ts:173:11)
```
The migration runner logs through a channel that needs a runtime namespace,
which a CLI process never has. So the runner cannot be used from the CLI at all.

**7. An empty database is not enough either.**
Creating the database by hand and rebuilding crashes: the build writes to its
own ledger table before anything has created the schema.
```
error: relation "build_runs" does not exist
```

**8. The documented setup bypasses mise, and the check that enforces mise's lock
then cannot see mise's tools.**
`mise.toml` asks for every tool at `latest` and `mise.lock` records the exact
release that must run; `toolchain:resolved` enforces that pairing on every
build. But `docs/setup.md` says to `brew install` Bun and Go and never mentions
mise at all, so a user following it installs neither mise nor the locked
releases. (This run got Bun 1.4.2 from Homebrew by coincidence. A different
Homebrew release would have failed the check outright.)

The check then throws rather than failing cleanly, twice, naming one tool per
build (~5 min each):
```
toolchain:resolved ... FAIL
  threw instead of returning a result:
Error: Executable not found in $PATH: "tmux"      (then, next build: "rustc")
```
The cause is that `normalizeRuntimePath` only REORDERS the PATH — it moves
mise's shims to the front when they are already there, and returns the PATH
unchanged when they are not:
```ts
if (shimsDirs.length === 0) return value;
```
So with mise installed but not activated in the shell (the default), the check
probes a PATH with no mise on it. Its hint — "run `mise install`… something is
shadowing it" — points the wrong way: nothing is shadowing anything, the shims
directory is simply absent. Putting it on the PATH fixed `tmux` and `rustc`
together.

Also stale in the same file: the header still calls Postgres an external
prerequisite "installed manually; runs as a system service", and says the
claude CLI is "already installed at ~/.local/bin/claude".

**9. Claude Code is never mentioned, installed, or checked.**
The whole point of the app is agents, and every agent launch needs the local
`claude` binary. `docs/setup.md` says nothing; `mise.toml` calls it an external
prerequisite "already installed at ~/.local/bin/claude". A new user reaches a
working app that cannot do the thing it is for.

**10. The app a new user lands on is the author's.**
The home screen shows all 14 apps, including Sonata, Mail, Deploy, Studio and
the equin website. (Already known — recorded in the earlier Findings page, and
confirmed here by screenshot.)

**11. Nothing restarts the gateway after a reboot.**
The machine was rebooted after the app was deployed and working. Nothing came
back: no gateway, no Postgres, and `http://equin.localhost:9000` simply
does not answer until `./equin start` is run again by hand. No doc
mentions this, and a new user's first reboot looks like the install broke.

**12. Minor: the browser fails to post its logs on first load.**
Six `POST /api/logs/emit → net::ERR_ABORTED` on the freshly deployed app. Not
blocking; worth a look.
*Diagnosed 2026-09-25: a false positive in the e2e harness, not an app failure.
The six emits succeeded with a 204, which Chromium reports to Playwright as
`requestfailed ERR_ABORTED` because the body is empty. See
`research/2026-09-25-framework-e2e-empty-body-requestfailed.md`.*

## Two notes about the harness itself

- The base image has no Tart guest agent, so every command goes over ssh. The
  harness generates its own throwaway key and types the default password once.
- A step marked "expected failure" records its error and carries on, so the run
  is repeatable end to end without stopping at blockers already written down.

## Not covered

- Apple Silicon and macOS 26 only. Nothing here says anything about Intel Macs,
  older macOS, or Linux.
- Checkpoint 4 (an agent actually runs) needs Claude Code installed and logged
  in, which needs a person and a browser in the virtual machine.
- The guest's `admin` user has passwordless `sudo`; a real user types a password.
