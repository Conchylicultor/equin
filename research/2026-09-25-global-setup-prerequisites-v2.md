# Setup prerequisites, v2: a mise-owned doctor, the ordered setup doc

Supersedes `2026-09-25-global-setup-prerequisites.md`. v1 put the check in a standalone
shell script and added a `./equin prereqs` command. v2 moves the check into mise,
drops the command, and adds the pieces that the roadmap page asked for and v1 missed.

## Context

This is step 2 of the roadmap page "[Planned] Installable by others" (block-cc11355f…):
the one-command install. The work comes from that page's Baseline run 1 (clean macOS VM,
2026-09-18). The run's database blockers (#3–7) and the Postgres-client bundling (2b)
have since landed on main (1a7bfdf45, 95df8994d). This plan covers what remains:

- **#1:** Xcode command-line tools are never mentioned, so `git clone` fails on a clean
  Mac. Rust also needs their `cc` linker.
- **#8:** nothing puts mise on PATH. `curl mise.run | sh` installs to `~/.local/bin`,
  which a fresh shell does not have on PATH. When mise's shims are absent,
  `normalizeRuntimePath` returns PATH unchanged, so `toolchain:resolved` *throws*,
  naming one tool per ~5-minute build. Its hint ("something is shadowing it") also
  points the wrong way.
- **#9:** Claude Code is never mentioned, installed or checked.
- Roadmap step 2 asks for "a doctor command that names each missing tool up front,
  including a logged-in Claude Code CLI". It also asks that the git hooks be set
  automatically.
- `mise.toml`'s header still says "claude CLI (already installed at
  ~/.local/bin/claude)".

Owner constraints, from that page:
- Prefer putting logic in mise over bash.
- The chain is: install mise → `mise install` → `./equin start`.
- A future `install.sh` should be only a minimal wrapper around that chain.

## Design

### 1. `mise run doctor`: the one prerequisite check

A `[tasks.doctor]` in `mise.toml`, whose body is a file task,
`mise-tasks/doctor` (POSIX sh, mise's own file-task convention). It collects **every**
failure, then prints all of them, each with why the repo needs it and the exact fix
command. It exits 1 if any failed.

| Item | Probe | Fix printed |
|---|---|---|
| Not root | `id -u` ≠ 0 | wording of `assertSupportedHost` (`infra/launcher/server/internal/boot.ts`) |
| Xcode CLT (darwin) | `xcode-select -p` | `xcode-select --install` |
| git works | `git --version` succeeds (catches the CLT stub) | CLT / distro package |
| mise's shims on PATH | `${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims` is in `$PATH` | `mise activate` line for `$SHELL` (zsh/bash) |
| Locked tools installed | `mise install --dry-run-code` (reads `mise.toml` + `mise.lock`); list them via `mise ls --missing` | `mise install` |
| Claude Code installed | `claude` on PATH, `$SINGULARITY_CLAUDE_BIN`, or the fallback paths in `infra/paths/server/internal/bins.ts` | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Claude Code signed in | `claude auth status --json`, read its logged-in field. Confirm the shape and exit code while logged out before relying on it. | `claude auth login` |

The tool list comes from mise itself, so adding a tool to `mise.toml` needs no change
here. Floors, holds and shadowing stay with `toolchain:resolved`. The doctor only asks
"is it there", and it is fast (it does not probe `rustc`).

### 2. Where it runs

- **`mise install`**: the `postinstall` hook becomes `mise run setup && mise run doctor`.
  A new user finds out everything that is missing at the step they are already told to
  run. The hook's failure is visible, but it does not undo the install.
- **`./equin start` and `./equin build`, as their first step.** This catches
  things that broke after install (logged out, shims dropped off PATH) before any costly
  work. It lives in `bootstrap/cli` as `assertPrerequisites()`, which spawns
  `mise run doctor` via `spawnCaptured` and prints its report on failure. If `mise`
  itself cannot be found, it reports that as the one failure, with the install line.
  `start` calls it before `assertSupportedHost()`, and `build` calls it before
  generation and checks. The release `launch` does **not** call it: a bundle needs no
  dev toolchain.
- **On demand**: `mise run doctor`. No `./equin` spelling, since that would need
  Bun, which the doctor may be reporting as missing.

### 3. Git hooks become automatic

`[tasks.setup]` gains `git config core.hooksPath .githooks`. It is idempotent, and it
runs on every `mise install`, including in worktrees (the config is shared per clone).
The doctor does not check hooks, because setup sets them. `docs/setup.md` drops the
"Git hooks" section to one sentence saying setup handles it.

### 4. The wrapper, when Bun is absent

`singularity` gains one guard before `exec`: if `command -v bun` fails, print "Bun not
found: run `mise install` in this checkout (it also reports anything else missing), see
docs/setup.md" and exit 1. The comment explains why this is the one allowed pre-CLI
line: it cannot fail silently, and it replaces `exec: bun: not found`.

### 5. `toolchain:resolved` fails cleanly without mise

`plugins/toolchain/check/index.ts`: when a probe cannot spawn (ENOENT), or the runtime
PATH has no mise shims, collect it as a mismatch instead of throwing. The hint then
branches:
- "mise's shims are not on PATH: `mise activate`, then `mise install` (and
  `mise run doctor`)" when the shims are absent;
- the existing "shadowing" hint only when the shims are present and a tool still
  resolves elsewhere.

Every tool is reported in one run.

### 6. Docs

`docs/setup.md`, Prerequisites through First run, becomes one ordered, copy-pasteable
sequence:

1. `xcode-select --install` (macOS). Linux: `git curl build-essential`.
2. `curl https://mise.run | sh`, then add the `mise activate` line for your shell and
   open a new shell.
3. `curl -fsSL https://claude.ai/install.sh | bash`, then `claude auth login`.
4. `git clone …` and `cd` into it.
5. `mise install`. This installs the locked toolchain, trusts worktrees, sets the git
   hooks and runs the doctor, which must end all green.
6. `./equin start`, then `./equin build --allow-main`.

The non-root, "don't install Bun/Go another way", Postgres and "cloned someone else's
repo" sections stay as they are.

`mise.toml` header: list what mise does not provide (Xcode CLT / git, Claude Code,
signed in), point at `docs/setup.md` and `mise run doctor`, and keep the Postgres note.
`plugins/toolchain/CLAUDE.md` gets a line noting that the doctor exists and what it
covers versus `toolchain:resolved`.

## Files

- `mise.toml`: header, `[tasks.doctor]`, setup sets hooksPath, postinstall runs doctor
- `mise-tasks/doctor` (new, POSIX sh)
- `singularity`: the Bun-absent guard
- `plugins/framework/plugins/cli/plugins/bootstrap/cli/prerequisites.ts` (new), plus its
  barrel export and `bootstrap/CLAUDE.md`
- `plugins/framework/plugins/cli/plugins/{start,build}/cli/run.ts`: call it first
- `plugins/toolchain/check/index.ts`: clean failure and the branched hint
- `docs/setup.md`, `plugins/toolchain/CLAUDE.md`

## Verification

- A bun test (`bootstrap/cli/prerequisites.test.ts`) runs `mise-tasks/doctor` with
  `PATH` at a temp dir of stub executables:
  - Everything missing: exit 1, and git, shims, claude and the missing tools are **all**
    named in one run.
  - All stubs present and "logged in": exit 0.
  - Logged out: exactly the sign-in line.
  - A second test asserts that the doctor's claude fallback paths match `bins.ts`.
- A `toolchain:resolved` test: a runtime PATH with no shims returns `ok:false`, names
  every tool and gives the shims hint, and does not throw.
- Manual:
  - `env -i HOME=$HOME PATH=/usr/bin:/bin ./equin build` prints the Bun
    guidance.
  - `mise run doctor` on this machine is all green, which also confirms the
    `claude auth status` field.
  - `./equin build` succeeds, with the doctor at the top of its output.
- After merge, worth one re-run of the clean-VM harness (`sidequests/clean-install/`).
