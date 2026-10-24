# The runtime PATH always has mise's shims, whether or not the shell activated mise

## Context

Report (clean macOS VM, 2026-09-18): mise was installed but not activated in the shell. `toolchain:resolved` threw
`Executable not found in $PATH: "tmux"`, the build treated the throw as a bug in the check, and threw away a build that
had otherwise succeeded. The hint said something was shadowing the tool (nothing was), and only the first missing tool
was named, so finding each one cost another ~5 min build.

**Already fixed at HEAD** (`9eb63fbcb`, "prerequisite doctor", pushed today):
- A probe that hits ENOENT is now collected rather than thrown, so every missing tool is named in one run. I checked
  Bun's error here: it throws `code: "ENOENT"` with the exact message from the report, so the catch does match.
- The hint now depends on whether shims are on PATH (`hasMiseShims`): "activate mise", not "something is shadowing it".
- `doctor.sh` reports "mise installed but not active" up front.

**Still broken: the root cause.** `normalizeRuntimePath` (`plugins/infra/plugins/launcher/core/internal/runtime-env.ts`)
only *reorders* PATH. When the starter's PATH has no mise entry, it returns the PATH unchanged
(`if (shimsDirs.length === 0) return value;`). So what the runtime can see still depends on how the starter's shell was
set up, which is exactly the kind of accident `runtime-env.ts` exists to remove. The consequences:
- `./equin start` launched from a shell where mise is not active (bun installed some other way, or a launchd or
  systemd unit) gives the gateway and every backend a PATH with no mise on it. They then run Homebrew's tmux, or no tmux
  at all.
- `toolchain:resolved` probes that same PATH. Its comment says it probes "the runtime's PATH", but that is only true
  when mise happens to be on the starter's PATH.
- The toolchain-upgrade gates (`toolchain/cli/internal/gates.ts`) have the same hole.

## Approach: work out where mise's shims are from the environment, not from PATH

mise keeps its shims in a fixed place given by the environment: `$MISE_DATA_DIR/shims`, else
`$XDG_DATA_HOME/mise/shims`, else `$HOME/.local/share/mise/shims`. So the runtime PATH can be computed from the
**whole environment** instead of from PATH alone. The shims are then first on PATH whether or not anyone ran
`mise activate`.

This takes the top rung of the fix ladder: the function no longer accepts a PATH on its own, so no caller can
normalise a PATH without the environment that says where mise lives.

### 1. `launcher/core/internal/runtime-env.ts`
- Replace `normalizeRuntimePath(value: string)` with **`runtimePath(env: Record<string, string | undefined>): string`**.
- Which shims directory goes first, strongest source first (the first two are the rules that exist today):
  1. an explicit `…/mise/shims` entry already on PATH (the directory the starter's own mise uses);
  2. one derived from a stripped `…/mise/installs/…` entry;
  3. **new:** `miseShimsDir(env)`, meaning `MISE_DATA_DIR` → `XDG_DATA_HOME/mise` → `HOME/.local/share/mise`, then
     `/shims`. Returns nothing only when `HOME` is also unset, and then PATH is returned as it is.
- It stays a pure function with no fs access, so it can stay in `core/`. A PATH entry that does not exist is harmless:
  a machine with no mise at all just gets one dead entry, and the tools still resolve further down PATH.
- It is still idempotent. The gateway's children do not receive `MISE_DATA_DIR`, but by then the shims entry is
  explicitly on PATH (rule 1), so they get the same result.
- `pickRuntimeEnv` / `pickHostEnv` call `runtimePath(source)`. They already have the whole source environment.
- Delete `hasMiseShims`: once the shims are always on the runtime PATH it has no question left to answer. Remove it from
  the barrel and remove its test.
- Rewrite the doc comment. The claim that "if the stripped entries were the only way … never hand a PATH with no
  toolchain" now holds in every case, including a shell that never activated mise.

### 2. `toolchain/check/index.ts`
- `env = { ...process.env, PATH: runtimePath(process.env) }`. The "runtime's PATH" comment is now true.
- Hint: drop the `shimsOnPath` branch. Instead, use `existsSync(miseShimsDir)` (fs is allowed in `check/`) to decide:
  - the shims dir is missing: "mise is not installed, or has installed nothing yet (`<dir>` does not exist). Install mise
    and run `mise install`; `mise run doctor` lists anything else missing."
  - otherwise: "Run `mise install` in this checkout …" plus the shadowing sentence, which is now the only situation where
    it can be true.
  - To support this, export `miseShimsDir(env)` from `launcher/core`. The check and `runtimePath` then share one
    derivation.

### 3. `toolchain/cli/internal/gates.ts`
- `gateEnv()` → `{ ...process.env, PATH: runtimePath(process.env) }`.

### 4. `doctor.sh`
- Keep "mise installed but not active". The interactive shell still needs it, because `./equin` finds `bun`
  through the shell's PATH. Rewrite its reason to say exactly that: the runtime no longer depends on activation, your
  shell does.
- Look up its shims dir in the same order: add the missing `XDG_DATA_HOME` step, i.e.
  `${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}/shims`. Add a comment pointing at `miseShimsDir`.

### 5. Tests: `runtime-env.test.ts`
- Rename the existing `normalizeRuntimePath` cases to `runtimePath({ HOME, PATH })`. Their expectations do not change.
- Replace "leaves a PATH with no mise entry untouched" with: **no mise entry on PATH → `HOME/.local/share/mise/shims`
  is prepended**. That is the case from the report.
- New tests:
  - `MISE_DATA_DIR` wins over `XDG_DATA_HOME`, which wins over `HOME`;
  - an explicit shims entry on PATH wins over the derived one;
  - with no `HOME` and no mise vars, PATH comes back unchanged;
  - running the result through `pickHostEnv` a second time without `MISE_DATA_DIR` gives the same PATH (idempotency
    across the gateway boundary).
- Update the `pickRuntimeEnv` / `pickHostEnv` cases to match.

### 6. Docs
- `plugins/infra/plugins/launcher/CLAUDE.md` (§ PATH normalisation) and `plugins/toolchain/CLAUDE.md:43`: rename, and
  say that the shims are derived from the environment. Autogen docs are regenerated by the build.

## Known behaviour this plan does not change (noting it, not fixing it)
The comment claims that "a shim with no version configured for the directory it runs in falls through to the next PATH
entry". I saw otherwise while exploring: running `bun` from a directory with no `mise.toml` fails with
`mise ERROR No version is set for shim: bun`. This behaviour already applies to every activated setup today. This plan
adds the shims for non-activated starters as well, so a runtime process that runs a mise tool from outside the repo
would now hit it too. Nearly all runtime spawns run inside a checkout. I'll correct the comment and file it with
`add_task` rather than widen this change.

## Verification
- `./equin test plugins/infra/plugins/launcher plugins/toolchain`
- Reproduce by hand: `env -i HOME=$HOME PATH=/usr/bin:/bin:$(dirname $(which bun)) ./equin check toolchain:resolved`
  (PATH with no mise entry). Before the fix this reports tmux/rustc not on PATH. After it, it passes because the
  derived shims resolve them.
- Same with `HOME` pointing at an empty temp dir: the check fails with the "shims dir does not exist" hint and names
  every tool in one run.
- `./equin build` (background); `./equin check launcher:runtime-env-declared`.
