# Setup prerequisites: complete the list, and check them all at once

## Context

A from-scratch install in a clean macOS VM (2026-09-18) followed `docs/setup.md` and hit
one missing tool at a time. Several of them only showed up after a ~5 minute build.

**Already fixed on main** (95df8994d, after the VM run): the Prerequisites section now
installs Bun, Go, tmux and Rust through `mise install`, says not to install Bun or Go any
other way, and drops the Postgres client (it now ships in `database/client-tools`).
`mise.toml`'s Postgres paragraph was corrected in the same commit.

**Still broken:**

| Gap | Symptom on a clean Mac |
|---|---|
| Xcode command-line tools not mentioned | `git clone` fails (`/usr/bin/git` is a stub). Rust also needs the `cc` linker from them. |
| mise's install dir and shims never put on PATH | `curl mise.run \| sh` installs to `~/.local/bin/mise`, which a fresh zsh does not have on PATH. `./equin` then dies with `bun: not found`. |
| Order is implicit | `mise install` must run inside the clone, after git works. The doc lists it before cloning is ever mentioned. |
| Claude Code not mentioned | The app launches agents with it. `paths/server/internal/bins.ts` falls back to the bare name `claude`, so the failure shows up only when the first agent launches. |
| `mise.toml` header | Still says "claude CLI (already installed at ~/.local/bin/claude)". |
| No aggregate check | Each missing tool surfaces on its own: `exec bun` fails, then the `toolchain:resolved` check fails partway through the build, then the first agent launch fails. |

Goal: the doc gets a new machine from nothing to a running app in one ordered pass. One
fast check names **every** missing prerequisite, with the install command for each,
before anything costly runs.

## Design

### 1. One prerequisite script, POSIX `sh`

`plugins/framework/plugins/cli/plugins/bootstrap/prereqs.sh`. It must be shell because
its most important case is **Bun itself missing**, where no TypeScript can run. It is
the single source for the check; nothing duplicates its list in TS.

It collects every failure into a list and prints them all, then exits 1 if the list is
non-empty. Each line names the missing item, why the repo needs it, and the exact
command to fix it:

| Item | Probe | Fix printed |
|---|---|---|
| Not root | `id -u` ≠ 0 | same wording as `assertSupportedHost` |
| Xcode CLT (darwin only) | `xcode-select -p` | `xcode-select --install` |
| git | `command -v git` and `git --version` succeeds (catches the CLT stub) | CLT on macOS / distro package on Linux |
| mise | `command -v mise`, else `~/.local/bin/mise` exists → "installed but not on PATH" | `curl https://mise.run \| sh` / the `mise activate` line for the user's shell |
| mise shims on PATH | `$HOME/.local/share/mise/shims` (or `$MISE_DATA_DIR/shims`) is in `$PATH` | `mise activate` line |
| Locked tools installed | `mise install --dry-run-code` (exit 1 ⇒ something in `mise.toml`/`mise.lock` is not installed); lists them via `mise ls --missing` | `mise install` |
| Claude Code | `command -v claude`, or `SINGULARITY_CLAUDE_BIN`, or the fallback paths in `bins.ts` | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Git hooks | `git config core.hooksPath` = `.githooks` | `git config core.hooksPath .githooks` |

The tool list comes from `mise.toml` and `mise.lock` through mise itself, so adding a
tool there needs no change here. Version correctness (floors, holds, shadowing) stays
with `toolchain:resolved`. This script only answers "is it there at all", which is fast
(no `rustc` probe).

### 2. Where it runs

- **Wrapper, only when Bun is absent.** `singularity` gains one guard:
  `command -v bun >/dev/null 2>&1 || exec sh plugins/…/bootstrap/prereqs.sh`.
  This keeps the spirit of the wrapper's "nothing before the CLI" rule: the guard cannot
  fail silently, and it replaces an opaque `exec: bun: not found` with the full report.
  The comment gets updated to say why this one exception exists.
- **`./equin start` and `./equin build`, as their first step**, through a
  `assertPrerequisites()` exported from `bootstrap/cli`. It spawns the script with
  `spawnCaptured`, prints the report and exits on failure. `start` calls it before
  `assertSupportedHost()`. `build` calls it before migration/doc generation and checks.
  Cost is roughly 100 ms (one `mise` call plus a few `command -v`).
- **`./equin prereqs`** as a standalone command, and it is what the doc tells a new
  user to run after `mise install`. It is also runnable directly as
  `sh plugins/…/prereqs.sh` before Bun exists.

The release `launch` path does **not** run it: a bundle needs no dev toolchain. It keeps
only `assertSupportedHost`.

### 3. `docs/setup.md` rewrite of Prerequisites / First run

One ordered, copy-pasteable sequence:

1. `xcode-select --install` (macOS). Linux: `git`, `curl`, `build-essential`.
2. Install mise and **activate it**: `curl https://mise.run | sh`, then
   `echo 'eval "$(~/.local/bin/mise activate zsh)"' >> ~/.zshrc` (bash variant noted),
   and open a new shell.
3. Install Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`.
4. `git clone …` and `cd` into it.
5. `mise install`. This installs bun, go, tmux and rust from `mise.lock`, and the setup
   hook trusts worktrees.
6. `git config core.hooksPath .githooks`.
7. `./equin prereqs`. It must print all green before continuing.
8. `./equin start` and `./equin build --allow-main`.

Keep the existing "Don't install Bun or Go another way", non-root and "Postgres needs no
install" paragraphs. Fold the separate "Git hooks" section into step 6. Keep the Postgres
and "cloned someone else's repo" sections as they are.

### 4. `mise.toml` header

Replace the stale claude line. The new header lists what mise does *not* provide (Xcode
CLT / git, Claude Code), points at `docs/setup.md` and `./equin prereqs`, and keeps
the Postgres note.

## Files

- `singularity` (wrapper): Bun-absent guard and updated comment
- `plugins/framework/plugins/cli/plugins/bootstrap/prereqs.sh` (new)
- `plugins/framework/plugins/cli/plugins/bootstrap/cli/prereqs.ts` (new):
  `assertPrerequisites()`, exported from its `cli/index.ts`
- A `prereqs` command. It follows the declaration pattern of the other
  `framework/plugins/cli/plugins/*` commands, probably a small sub-plugin
  `cli/plugins/prereqs`.
- `plugins/framework/plugins/cli/plugins/{start,build}/cli/run.ts`: call it first
- `docs/setup.md`, `mise.toml`, and `bootstrap/CLAUDE.md` (document the script)

Reuse: `spawnCaptured` (`infra/spawn/core`) for invoking the script; the claude fallback
paths already in `infra/paths/server/internal/bins.ts` (the script mirrors them; a test
asserts they agree); root wording from `assertSupportedHost` (`infra/launcher/server/internal/boot.ts`).

## Verification

- `prereqs.test.ts`: run the script with `PATH` pointed at an empty temp dir and
  `HOME` at a temp home. It must exit 1 and name git, mise, Bun/tools and claude in a
  **single** run. Then run it with stub executables for each probe on PATH, and it must
  exit 0. Also add a test that the claude candidate paths match `bins.ts`.
- Manual: `env -i HOME=$HOME PATH=/usr/bin:/bin ./equin` prints the full report
  (not `bun: not found`). `./equin prereqs` on this machine is all green.
- `./equin build` still succeeds, with the prereq step visible at the top of its
  output.
- Out of scope: re-running the clean-VM install. It is worth doing once after merge.
