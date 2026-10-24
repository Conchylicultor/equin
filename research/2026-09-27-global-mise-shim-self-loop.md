# mise shims rewritten into a self-loop — root cause, prevention, detection

## Context

On 2026-09-27 at 12:44:27 local time, every entry in `~/.local/share/mise/shims/` became a symlink to
`shims/bun`, and `shims/bun` pointed at itself. From then on every worktree deploy failed. The
gateway spawns backends as `taskpolicy -b -- bun …`, and resolving `bun` fails with ELOOP, which
taskpolicy reports as `posix_spawn: No such file or directory`. `./equin await` said
"bun not found". The old backend kept serving, so it looked like a code problem.

### Root cause (confirmed from the host state and the session transcript)

None of the repo's code paths caused it. Agent session `att-1790505159-xgh3`
(transcript `d0ecdf69-…jsonl`) cloned a third-party repo (`cannoneyed/wheel`) into its
scratchpad. That repo ships a `.mise.toml` pinning **bun 1.3.14**. The agent then ran:

```
10:44:26Z  cd …/scratchpad/wheel && … cat .mise.toml; bun --version
```

- `~/.local/state/mise/tracked-configs/91bcf28857f2bb51 → …/scratchpad/wheel/.mise.toml` was recorded at 12:44:27.
- `~/Library/Caches/mise/lockfiles/3c9ac80e…` was written at 12:44:28.
- `installs/.mise-installs.toml` and `installs/bun/.mise.backend.toml` were written at 12:44:29.
- By 10:45:05Z the agent was running `~/.local/share/mise/installs/bun/1.3.14/bin/bun` directly. That install did not exist before.

How the chain happened:

1. `bun` resolved to the shim. The shim is mise itself, invoked as `argv[0]=…/shims/bun`.
2. The shim read the foreign `.mise.toml`, found bun 1.3.14 missing, and ran **`not_found_auto_install`** (on by default, and on here). That installed bun 1.3.14.
3. The install finished with a reshim. mise writes each shim as a symlink to its own `current_exe()`. On macOS that returned the path it was *invoked as*, which was `shims/bun`, not `~/.local/bin/mise`. Every shim, `bun` included, now pointed at `shims/bun`. This is a mise bug (2026.9.10).

At 13:00 the same agent removed bun 1.3.14 and ran `~/.local/bin/mise reshim --force`, which is why
the shims are correct again now.

### The four code paths named in the task all ruled out

- `miseBin()` (`plugins/toolchain/shared/mise.ts`): `mise` is not a mise-managed tool, so `shims/mise` never exists and `Bun.which` can't return a shim. Here it falls back to `~/.local/bin/mise`, because `~/.local/bin` is not on PATH.
- `mise trust` (`worktree.ts:451`): it spawns bare `"mise"`. mise is not on PATH, so it currently fails with ENOENT, and an empty `.catch` hides that. It never ran anything, so it was harmless here, but it is a latent silent failure (see Follow-ups).
- `toolchain upgrade` (`self-update`, `install`, `lock`): it goes through `miseBin()`, so it uses the real binary. It did not run at 12:44.
- Doctor: it only runs `install --dry-run-code` and `ls --missing`, which install nothing.

## Plan

### 1. Prevention: shims never install (turn off `not_found_auto_install` machine-wide)

The trigger class is "a shim runs in a directory whose mise config asks for a version that isn't
installed". Agents constantly run `bun` inside foreign clones (scratchpads, `/tmp`), so this will
happen again. Once shims can't install anything, they can't reshim, and the mise bug can't fire.
Nothing in the repo relies on shim auto-install:
- `toolchain upgrade` installs explicitly (`mise install tool@ver`) into the shared installs dir, which main and the worktrees then pick up.
- A fresh machine goes through `install.sh`, which runs `mise install`.

After this change, a foreign repo's `bun` fails with mise's own "bun@1.3.14 is not installed" error.
That is loud, correct, and touches nothing shared.

- **`mise.toml` `[tasks.setup]`**: add `mise settings set not_found_auto_install false` next to the existing `trusted_config_paths` line. It is global and idempotent, like its sibling. Update the comment to explain why.
- **`doctor.sh`**: when `"$mise_bin" settings get not_found_auto_install` prints `true`, record a `miss` whose fix is `mise run setup`. Machines that already exist then get the setting on their next `build` or `start`, since doctor runs first. Otherwise they would only pick it up on their next `mise install`.

### 2. Detection: doctor names a broken shims directory, with the fix

Doctor already runs first in `./equin build` and `start`, and the `./equin` wrapper runs it
when `bun` can't be found. That makes it the one place that turns "backend never ready" or
"bun not found" into the real cause.

Add to `plugins/framework/plugins/cli/plugins/doctor/doctor.sh`, inside the mise-present branch, after
the "active in shell" check: every symlink in the shims dir must resolve. The check is `[ -L "$shim" ] && [ ! -e "$shim" ]`,
since `-e` follows the link and fails on both a loop (ELOOP) and a missing target. When it fires, the finding names the
broken shims and the fix `"$mise_bin" reshim --force`.

*Revised during implementation:* the first draft compared `readlink` output against the shims dir.
`readlink` is not a shell builtin, though, and doctor's contract (and its test's PATH) allows only builtins
plus the tools under check. The `test -e` form uses builtins only and also catches a dangling link, for example after mise moves.
It misses one state: a shim linking to a *healthy* other shim. A reshim writes every shim the same way, so that
state never occurs without the loop.

### 3. Tests: `plugins/framework/plugins/cli/plugins/doctor/cli/doctor.test.ts`

Follow the file's existing style (stub tools on PATH, a temp `MISE_DATA_DIR`):
- A shims dir whose `bun → shims/bun` and `go → shims/bun`: the run fails and names `bun go` and `reshim --force`.
- A shims dir linking to the stub mise: no shim finding.
- The stubbed `mise settings get not_found_auto_install` prints `true`: the run fails and names `mise run setup`. When it prints `false`: nothing is reported.

Update the doctor's `CLAUDE.md` to list the two new checks.

## Follow-ups (file as tasks, not in this change)

- **`mise trust` in `worktree.ts:451` fails silently.** On this machine it has been an ENOENT no-op, hidden by `.catch(() => {})`. `trusted_config_paths` covers the same thing, so it is probably dead weight. Either delete it or route it through a shared `miseBin()` with a real error. `source-checkout.ts:347` has the same bare `"mise"`.
- **`mise settings add trusted_config_paths` does not dedupe.** The global config holds the same path three times, which contradicts the comment in `setup`.
- **Upstream mise issue**: a reshim triggered by auto-install from inside a shim writes shims that link to the shim (`current_exe` is not canonicalised on macOS). The local mise is 2026.9.10, and 2026.9.15 is available. Check whether it is already fixed before filing.

## Verification

1. `./equin test plugins/framework/plugins/cli/plugins/doctor` passes.
2. Manual run on a copy only, never the live shims dir: build a temp `MISE_DATA_DIR/shims` with looped symlinks, run `MISE_DATA_DIR=<tmp> sh doctor.sh`, and confirm the finding and the fix line appear.
3. `mise run setup`, then `~/.local/bin/mise settings get not_found_auto_install` returns `false`. In a scratch dir with a `.mise.toml` pinning `bun = "1.3.14"`, `bun --version` then errors "not installed". `ls -la ~/.local/share/mise/shims` is unchanged, and `installs/bun` still has only 1.4.2.
4. `./equin build` still succeeds, since doctor passes on a healthy machine.
