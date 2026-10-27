# Clean install — a from-scratch install run, without a second Mac

Host tooling, not part of the app (same spirit as
[`sidequests/monitors`](../monitors/CLAUDE.md)). Answers: if someone with no
Homebrew/Bun/Go/Postgres/`~/.equin` follows `docs/setup.md` exactly as
written, where do they get stuck, and how long does each step take?

## Why a VM

This Mac already runs a real equin instance: gateway on the hardcoded
port 9000, embedded Postgres, state under `~/.equin`. A second macOS
user account would still see this Mac's Homebrew and would collide on port
9000, so it isn't clean. Instead this runs inside a throwaway VM via
[Tart](https://github.com/cirruslabs/tart) (`~/.local/bin/tart`), cloned
fresh each time from `ghcr.io/cirruslabs/macos-tahoe-vanilla` (no
Homebrew/Xcode CLT/Bun/Go/Postgres/Claude Code — just an `admin` user with
remote login on). The VM has its own network/disk and a capped 6 core /
12 GB, so its port 9000, `~/.equin` and Postgres are its own; nothing
under this Mac's `~/.equin` is ever touched.

## Running it

```bash
sidequests/clean-install/run.sh
```

Clones a VM named `si-clean-<timestamp>`, sizes it, boots it headless, runs
each `steps.sh` step inside it in order (logging the exact command, output,
exit code, duration). Success: prints a summary table, deletes the VM.
Failure: stops immediately, leaves the VM running, and prints the exact
command to get a shell inside it.

Flags: `--gui` (window instead of headless — needed once, for the
interactive Claude Code login), `--keep` (don't delete on success), `--from
N` (resume a kept VM at step N instead of reinstalling from scratch),
`--name`/`--out`/`--cpu`/`--memory` (see `run.sh --help`), and `--steps <file>` (which steps file to run; default
`steps.sh`).

## `steps-install.sh` — the one-command install

```bash
sidequests/clean-install/run.sh --steps steps-install.sh
CLEAN_INSTALL_SH=$PWD/install.sh sidequests/clean-install/run.sh --steps steps-install.sh   # before it is on main
```

The README's one command (`curl … install.sh | bash`), then what a new user
would check: a new terminal finds the tools, the app answers and renders, it
comes back by itself after a reboot, and `mise run doctor` is clean. Every
step is `from-docs`; a run passes only with no other tag and no
`_EXPECT_FAIL`. Headless and unattended: Claude Code is installed but not
signed in, which the doctor reports as advice, not a failure.
`CLEAN_INSTALL_SH` pipes a local `install.sh` instead of fetching the URL, for
verifying a change before it is on main.

When the change also touches what the installer clones (e.g. the doctor), the
guest must install that tree, not `main`. Snapshot it into a git bundle (a
throwaway repo outside the worktree: tracked + untracked files, one commit,
`git bundle create x.bundle main`), hand it over with `--upload
<bundle>:/tmp/equin.bundle`, and pass `CLEAN_INSTALL_ARGS="--repo
/tmp/equin.bundle"` — the installer's own `--repo`, the one a fork uses.

A step may set `<fn>_REBOOT=1`: `run.sh` reboots the guest (`sudo shutdown -r
now`) and records the time until ssh answers again, instead of running the
step's text.

`run.sh` refuses to run if its output dir would land under `~/.equin`,
or if the VM name doesn't start with `si-clean` — both so a mistake here
can't reach the real instance.

## `steps-migrate.sh` — the data-dir migration

Installs a tree from before the move to `~/.equin` (a bundle of a pre-move
commit), seeds a stored path and a Claude transcript dir, checks out the tree
under test (a second bundle), and runs `./equin data-dir migrate --apply`.
Then it checks that the legacy dir and label are gone, the app answers, the
stored paths moved, a second run has nothing to do, and the app comes back after
a reboot. Usage is in the file's header. Every step is `harness-only`.

## `steps.sh`

`docs/setup.md` turned into runnable steps, in the order a brand-new reader
hits them — including trying the prerequisite table's `brew install`
commands before Homebrew exists (expected to fail; that failure is the
finding, not a bug to route around). Each step is tagged `from-docs`,
`documented-elsewhere`, or `undocumented-knowledge` so the summary reads as
a diff against the docs. Nothing in the repo gets fixed as part of a run.
New steps get appended as later runs discover more gaps — see the comment
at the top of `steps.sh`.

## Gaps

- Apple Silicon + macOS 26 only. Not Intel, older macOS, or Linux.
- The guest's `admin` user has passwordless `sudo`; a real user types one.
  Still worth noting `sudo` use as friction even though the guest won't
  prompt.
- Claude Code login needs a person and `--gui --keep`, then resume with
  `--from`. `steps-install.sh` does not need it: the app runs signed out.
- The vanilla image has no Tart Guest Agent, so `tart exec` doesn't work
  against it at all — every guest command goes over ssh. `run.sh` generates
  a throwaway ed25519 key per run, types the guest's default password
  (`admin`) into it exactly once via `expect` (ships with macOS, nothing to
  install) to authorize that key, then uses key auth for every step after.
  A `--keep --from` resume reuses the same key from the output dir instead
  of prompting again.

Two tags beyond the three above appear in `steps.sh`. `harness-only` marks a
step no user could take, there so one run can also show what breaks past a
blocker. `<fn>_EXPECT_FAIL=1` marks a failure already written down in the
findings: the run records it and carries on, instead of stopping. Everything
else stops the run with the guest left running.

## Results

A run's findings go on the "Installable by others" track's wiki page as
agent sub-pages, not under `research/`. See
`research/2026-09-17-global-clean-install-baseline.md` for the full plan and
the checkpoints a baseline run is scored against.
