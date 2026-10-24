# Clean-install baseline without a second Mac

Status: plan, waiting for approval. Nothing installed or changed yet.
Track: "Installable by others" (page `block-cc11355f-6bc1-48a5-b4b6-e32b2aee6932`), step 1.

## Context

Step 1 of the track needs a from-scratch install, run as someone who is not the
author, on a machine without the author's leftovers (`~/.singularity`, mise trust
settings, a system Postgres, `~/.local/bin/claude`, git hooks config). The
Findings page lists likely blockers from reading code. None has been confirmed
by running an install.

The track owner asked first: how can we do this without access to another Mac?

The outcome is two things:

1. A repeatable way to run the install from the same clean starting point.
2. One baseline run, recording every step that fails or needs knowledge a new
   user doesn't have, in order, with the exact error and time taken. Nothing is
   fixed. The blockers are listed so they can be filed.

## Answer: a throwaway macOS virtual machine on this Mac

This Mac can run macOS as a virtual machine through Apple's virtualization
framework. Apple's license allows up to two per Mac. This machine has room: an
M5 Pro with 18 cores, 64 GB of memory and 646 GB of free disk, on macOS 26.4.

We use **Tart** (cirruslabs), a free command-line tool for macOS virtual
machines. Its `macos-tahoe-vanilla` image is close to a new Mac:

- no Homebrew, Xcode command-line tools, Bun, Go, Postgres or Claude Code
- one normal user (`admin`), with remote login on

Each run clones that image into a new virtual machine and deletes it afterwards.
Every run starts from exactly the same state.

### Why the running main instance is untouched

- **Ports.** The virtual machine has its own network. Its gateway on port 9000
  is not this Mac's port 9000. This matters because 9000 is hardcoded
  (`plugins/infra/plugins/namespace/core/namespace.ts`,
  `plugins/framework/plugins/cli/plugins/start/cli/run.ts`), and there is no
  setting to change it.
- **State.** It has its own disk. Its `~/.singularity`, embedded Postgres, the
  keychain entry for the secrets key, and git config are all separate. Nothing
  on this Mac's `~/.singularity`, gateway or Postgres is read or written.
- **CPU.** It is capped at 6 cores and 12 GB, so the main app and other agents
  keep most of the machine.

### Options ruled out

- **A second macOS user account.** Its gateway would clash on port 9000. It
  would also still see this Mac's Homebrew and system Postgres on port 5432,
  and the mise `setup` task would find and use that Postgres. So it isn't clean.
- **Redirecting the data folder with `SINGULARITY_DIR`.** This moves
  `~/.singularity`, but has the same port 9000 clash and the same shared tools.
- **A GitHub-hosted macOS runner.** Its image comes with Homebrew, Postgres and
  much more, which hides exactly what we want to find. You also can't log in to
  Claude Code there.
- **A Linux container.** It tests Linux. The proposed first target user is on
  macOS, and Linux is step 5 of the track.

## What changes on this Mac

- `brew install cirruslabs/cli/tart`
- A one-time pull of `ghcr.io/cirruslabs/macos-tahoe-vanilla:latest` (about
  25 GB, into `~/.tart`). The pull is not counted in the install timings.
- A new `sidequests/clean-install/`. It is host tooling, like
  `sidequests/monitors`, and not part of the app:
  - `CLAUDE.md`: what it is for, how to run it, what it isolates and what it
    doesn't
  - `run.sh`: the driver
  - `steps.txt`: the fixed list of steps run inside the virtual machine
  - a line in the root `CLAUDE.md` Sidequests list

## The driver: `sidequests/clean-install/run.sh`

1. `tart clone macos-tahoe-vanilla si-clean-<timestamp>`, then
   `tart set --cpu 6 --memory 12288`, then start it with `--no-graphics`
   (or with a window when `--gui` is passed, for the Claude login).
2. Wait until the guest answers (`tart exec`, which needs the guest agent in the
   cirruslabs images; the first step checks for it). If it isn't there, use ssh
   to `admin@$(tart ip …)`.
3. Run each line of `steps.txt` in the guest, in a login shell, as `admin`,
   inside the cloned checkout. Record per step:
   - start time, duration, exit code
   - the last 40 lines of output
   - full output to `<out>/NN-<step>.log`
4. Write `<out>/summary.tsv`: step, exit code, duration.
5. `tart delete` at the end, unless `--keep` is passed.

The driver stops at the first failing step and leaves the virtual machine
running. The person driving the run then decides the workaround (next section),
adds it to `steps.txt` as its own labelled step, and re-runs from a fresh clone.
The run only counts once it goes end to end from a fresh clone, so the recorded
path is fully repeatable.

## Protocol: act like a new user

A new user lands on the GitHub page and finds an empty README (52 bytes). The
only real instructions are `docs/setup.md`. So `steps.txt` starts as
`docs/setup.md` followed literally, in order:

1. `git clone https://github.com/Conchylicultor/singularity` (the repo is
   public, so no login)
2. The prerequisite table: `brew install oven-sh/bun/bun`, `brew install go`,
   `brew install postgresql@18`
   - Homebrew itself isn't installed, and the doc doesn't say to install it.
     That is the first expected finding.
3. `git config core.hooksPath .githooks` (the doc's Git hooks section)
4. `./equin start`
5. `./equin build --allow-main`

When a step fails, or the doc runs out:

1. Record the step, what the doc said, the exact error and the time taken.
2. Look for a fix only where a new user could find one: the error message
   itself, `mise.toml`, the repo's docs, or a plain web search.
3. Apply the smallest such fix as its own step, tagged `documented-elsewhere`
   or `undocumented-knowledge`.
4. If no reasonable new user could get past it, stop and record that as where
   the install ends.

Nothing in the repo is fixed as part of this task.

## Checkpoints

Each checkpoint records the time taken to reach it and the failures before it.

1. **Tools installed.** Xcode command-line tools, Homebrew, Bun, Go, and the
   Postgres client tools are on the PATH. Homebrew's installer normally pulls
   in the command-line tools.
2. **Gateway running.** `./equin start` succeeds, and
   `curl http://equin.localhost:9000` answers inside the guest.
3. **App deployed.** `./equin build --allow-main` finishes, the deploy
   receipt says `status: ok`, and the agent manager page renders. The last is
   checked with the repo's `screenshot.ts` run inside the guest (this also
   covers the Chromium provisioning).
4. **An agent works.** Install and log in to Claude Code, create a task, and
   launch an agent. That agent's own build deploys. This also covers the
   per-agent database copy (`pg_dump`/`pg_restore`) and commit attribution
   through the git hooks.

Checkpoint 4 needs a person once. Logging in to Claude Code opens a browser, so
the driver runs with `--gui --keep`, and the owner logs in through the virtual
machine's window. Using the owner's own Claude account is fine here, because
every real user needs an account too. The login is recorded as a step with its
time.

## Results

Recorded on the track page as agent sub-pages, not in `research/`:

- **"Clean-install harness"**: how to run it, what it isolates, and its gaps.
- **"Baseline run 1 (date)"**:
  - a table in the order things happened: step, what the doc said, what
    happened, exact error, time taken, category (fails / missing from docs /
    needs undocumented knowledge / slow)
  - the time to each checkpoint
  - a list of blockers, each ready to file as its own task

Then, per the track instructions:

- a short status update on the track page
- a follow-up task carrying the track page id and
  `block-361815ed-5750-413a-b5ab-31c5dc855144`

Note: on 2026-09-16, `edit_page` refused every edit to the track page. Its
markdown read-then-write round trip isn't lossless ("would itself create 1
block"). This needs fixing, or a task filed for it, before results can go on
the page.

## What this does not cover

- Apple Silicon on macOS 26 only. Not Intel, older macOS, or Linux.
- The vanilla image's `admin` user can run `sudo` without a password. A real
  user types one. Every `sudo` use is still recorded as friction.
- A 6-core, 12 GB guest is smaller than the author's machine. That is useful: it
  shows whether a modest machine is enough.

## Verification

- **Main is undisturbed.** Before and after the run on this Mac:
  - the process listening on port 9000 has the same PID
  - `http://equin.localhost:9000` answers
  - nothing under `~/.singularity` was modified during the run window
    (`fd --changed-within` limited to that window, excluding the live logs
    and DB files main writes itself)
- **The run is repeatable.** A second `run.sh` from a fresh clone reaches the
  same checkpoint with the same list of failures.
- **Cleanup.** `tart list` shows no leftover `si-clean-*` machines after a run
  without `--keep`.
