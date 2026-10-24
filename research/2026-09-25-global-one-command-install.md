# One-command install, verified in the clean-install VM

Status: plan, waiting for approval.
Track: "Installable by others", step 2 (the last part). Follows
[`2026-09-17-global-clean-install-baseline.md`](./2026-09-17-global-clean-install-baseline.md) and run 1
([`2026-09-18-global-clean-install-baseline-run-1.md`](./2026-09-18-global-clean-install-baseline-run-1.md)).

## Context

Run 1 found twelve blockers. On main today, most of them are already fixed:

| Run-1 blocker | State on main |
| --- | --- |
| 3–7 no base DB, circular `db fork`, `setup` probes 5432, `apply-migrations` crash, empty DB | fixed: the cluster starts with its base database (`1a7bfdf45`) |
| Homebrew needed for `pg_dump`/`pg_restore` | fixed: bundled client tools (`95df8994d`) |
| 8 tools found one build at a time, PATH without mise | fixed: doctor (`9eb63fbcb`), runtime PATH derives mise's shims (`6bbdd9c3d`) |
| 11 nothing restarts the app after a reboot | fixed on macOS: `start` registers a launchd LaunchAgent (`7d3a9a64e`) |
| 1, 2, 9 Xcode CLT, Homebrew, Claude Code not named | named in `docs/setup.md`, but as a 5-step sequence that has to be followed by hand |

What is left is the task itself:
- one command that runs that sequence;
- `README.md` saying what that command is (today it reads "More info coming soon");
- a VM run that proves the command works.

## Decision: Claude Code is advisory in `start` / `build`, not a gate

Today `doctor.sh` counts "Claude Code missing" and "not signed in" as missing prerequisites.
`assertPrerequisites()` then stops `start` and `build`. Neither command uses Claude, and the running app already checks
it at every use:
- `infra/claude-cli/plugins/availability` shows a Claude Code row in the health report, with the install / sign-in
  commands;
- `assertClaudeCodeReady()` / `requireClaudeBin()` refuse an agent launch with the fix.

So the gate only blocks. It blocks a new user from seeing the app before they have an account, and it would make the
installer (and the VM run) wait on an interactive browser sign-in.

Change: `doctor.sh` gets a second kind of finding, `advise` (named, with its fix, but not counted). Claude Code
"missing" and "not signed in" move there. Output: `all required present; 1 recommended: …`, exit 0. Everything else
stays a hard `miss`. `doctor.test.ts` changes to match: a signed-out or absent Claude passes, and the advice is still
printed. `doctor/CLAUDE.md` and `docs/setup.md` say that agents are unavailable until Claude Code is signed in, and that
the app says so itself.

## The installer: `install.sh` at the repo root

The file has to live at the root: the documented URL `…/main/install.sh` must stay the same when plugins move, and
raw.githubusercontent does not follow symlinks. It is POSIX-ish `bash`, with no dependency but what a clean Mac has
(`curl`, `bash`, `/usr/bin/git` stub).

Two entry points, one script:
```sh
curl -fsSL https://raw.githubusercontent.com/Conchylicultor/singularity/main/install.sh | bash
./install.sh            # from inside a clone or fork you already have
```
Options (flags, or env for `curl | bash -s -- …`):
- `--dir <path>` (default `~/singularity`; ignored when run from a checkout);
- `--repo <url>` (default the canonical repo, for forks);
- `--no-shell-rc` (skip the rc edit).

Steps. Each one checks before it acts, so running the script again resumes where it left off:
0. **Say what will happen, up front.** A short banner:
   - it installs the Xcode command-line tools (needs your password, once), mise and the locked Bun/Go/tmux/Rust, and
     Claude Code;
   - it adds one `mise activate` line to your shell rc;
   - it clones to `<dir>`, then starts and builds the app (~10–15 min);
   - agents need a Claude account (sign-in at the end);
   - macOS: the app comes back by itself at every login; Linux: re-run `./equin start` after a reboot.
   - It refuses to run as root, with the same message as the doctor.
1. **Xcode CLT** (macOS, when `xcode-select -p` fails): the headless `softwareupdate` route Homebrew uses (the
   `.installondemand.in-progress` marker, pick the latest "Command Line Tools" label, `sudo softwareupdate -i`). If no
   label is found, fall back to `xcode-select --install` and wait until `xcode-select -p` succeeds. This is the path
   `steps.sh` step 3 already showed works over ssh. On Linux, if `git`, `cc` or `curl` is missing, print the doctor's apt
   line and exit 1.
2. **mise**: if it is absent, `curl https://mise.run | sh`. Append `eval "$(~/.local/bin/mise activate <zsh|bash>)"` to
   the rc named by `$SHELL`, only if a grep does not find it already. Export the shims dir onto this process's PATH, so
   the rest of the script and the doctor see an active mise.
3. **Clone**: skipped when running from a checkout, or when `<dir>` is already a clone of the repo; otherwise
   `git clone`.
4. **Toolchain**: `cd <dir> && mise trust && mise install`. Its postinstall runs `setup` and the doctor. The doctor
   exits 1 only for a missing required item, which fails the script loudly (`set -euo pipefail`).
5. **Claude Code**: if it is absent, `curl -fsSL https://claude.ai/install.sh | bash`. Installing needs no person;
   sign-in is step 8.
6. **`./equin start`**
7. **`./equin build --allow-main`**: then read `~/.singularity/worktrees/<main ns>/build-status.json`. It must
   say `status: ok`; do not trust the exit code alone (root CLAUDE.md, step 3).
8. **Finish**:
   - print `http://equin.localhost:9000`;
   - print "open a new terminal (mise is now active there)";
   - if Claude is not signed in: when `/dev/tty` is readable (an interactive `curl | bash`), offer
     `claude auth login` < /dev/tty; otherwise print it as the one remaining step.

What the script does **not** do: install Homebrew (not needed any more), touch the system Postgres, or ever run
`./equin push`.

Docs:
- `README.md`: one paragraph on what equin is, the one-liner, the in-clone form, and a link to `docs/setup.md`.
- `docs/setup.md`: lead with "Quick install: the one-liner", and keep the existing manual sequence as "What it does,
  step by step".

Test: `install.test.ts` isn't possible at root without a plugin home, and the script is mostly orchestration of
external installers. Its verification is the VM run below. The one pure piece (arg parsing / the up-front banner)
stays small enough to review by eye. I am not adding a stub-harness test for it.

## Harness: `sidequests/clean-install/`

`steps.sh` stays as run 1's record, since it is a diff against the docs of that day. Changes:
- `run.sh --steps <file>` (default `steps.sh`): picks the steps file to source.
- A step may set `<fn>_REBOOT=1`. `run.sh` then sends `sudo shutdown -r now`, treats the ssh drop as expected, reuses
  its existing wait-for-sshd loop, and records the time until ssh answers again. (Tart's vanilla image logs `admin` in
  automatically, which is what loads a LaunchAgent. If it turns out not to, the post-reboot check records that as the
  finding. I will not work around it.)
- A new `steps-install.sh`, all `from-docs` (the README is the doc):
  1. baseline (`sw_vers`, arch, `whoami`)
  2. **the one command**. It pipes the host's `install.sh` to `bash` in the guest. The file is not on `main` yet, so a
     `curl` of the raw URL would fetch nothing; the script body is byte-identical. The `_DOC` line says so. After the
     push, rerun with the real `curl … | bash` as the final confirmation.
  3. a fresh `zsh -i -c 'command -v bun mise; cd ~/singularity && ./equin --help >/dev/null'`: a new terminal
     works without hand edits.
  4. `curl` `equin.localhost:9000` → 200, and `build-status.json` → `ok`.
  5. `screenshot.ts`: the app renders.
  6. reboot (`_REBOOT=1`).
  7. the same `curl` plus a `status` check after the reboot: the app came back by itself.
  8. `mise run doctor`: all required items present, and Claude named as recommended.
- `CLAUDE.md` in the sidequest: document `--steps`, `_REBOOT` and the new file.

## Verification

- `./equin test plugins/framework/plugins/cli/plugins/doctor`
- `./equin build` (background) and `./equin check`.
- `sidequests/clean-install/run.sh --steps steps-install.sh` from a fresh VM clone, headless and unattended:
  - every step passes;
  - no step is tagged `undocumented-knowledge`, `documented-elsewhere` or `harness-only`, and none is `_EXPECT_FAIL`;
  - main is untouched (same port-9000 pid before and after).
- Record per-step timings and the result as a run-2 sub-page on the track page. If `edit_page` still refuses, put it in
  `research/`, as run 1 did.
- Re-run step 2 via the real `curl` URL after the user pushes.

## Not covered

- Claude sign-in inside the VM, and launching an agent (checkpoint 4). That is left for a later run.
- Intel Macs, macOS older than 26, and Linux. The script handles Linux paths, but nothing runs it there.

## Result: run 2 (2026-09-25), all steps passed

A fresh `macos-tahoe-vanilla` VM (6 cores, 12 GB), headless, with nobody at the keyboard. Command:
`CLEAN_INSTALL_SH=$PWD/install.sh CLEAN_INSTALL_ARGS="--repo /tmp/singularity.bundle" run.sh --steps steps-install.sh --upload <bundle>:/tmp/singularity.bundle`.
The bundle is a one-commit snapshot of this worktree. The doctor change is not on `main` yet, so the guest had to
install this tree.

| # | Step | Tag | Result | Time |
| --- | --- | --- | --- | --- |
| 1 | guest state (no CLT, brew, mise, bun, claude) | from-docs | ok | 1s |
| 2 | **the one command** | from-docs | ok: deploy receipt `ok` | 440s |
| 3 | new terminal: mise, bun, go, tmux on PATH; `./equin` runs | from-docs | ok | 1s |
| 4 | `curl :9000` → 200, `build-status.json` → ok | from-docs | ok | 0s |
| 5 | screenshot renders | from-docs | ok | 6s |
| 6 | reboot | from-docs | ok | 12s |
| 7 | app answers after reboot, nothing re-run | from-docs | ok: 200 after ~27s | 24s |
| 8 | `mise run doctor` | from-docs | all required present; Claude recommended | 1s |

Inside step 2, in order:
- Xcode CLT through `softwareupdate` ("Command Line Tools for Xcode 27.0");
- mise, and the rc line;
- clone;
- `mise install` (4 tools);
- Claude Code;
- `start`;
- `build`: checks ✓, web artifacts ✓.

After the reboot: guest uptime was 41s, `launchctl print gui/501/dev.singularity.gateway` showed `state = running`,
`runs = 1`, and a screenshot taken then rendered the Apps home.

No step is `undocumented-knowledge`, `documented-elsewhere` or `harness-only`, and none is `_EXPECT_FAIL`.

The first attempt, against `main`'s clone, stopped at `start`, where the old doctor refused
"Claude Code is not signed in". That is the gate this change removes.

Still to do once pushed: re-run step 2 with the real `curl` URL (no `CLEAN_INSTALL_*`).
