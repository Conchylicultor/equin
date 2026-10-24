# CLI: kill the silent pre-CLI exit — one serialized, loud, freshness-gated `ensureDeps`

## Context

Every `./equin <cmd>` can die with **exit 1 and zero bytes of output**, before the
CLI ever starts. The wrapper is four lines:

```sh
set -e
cd "$(dirname "$0")"
bun install --silent
exec bun plugins/framework/plugins/cli/bin/index.ts "$@"
```

When that `bun install` fails, `set -e` aborts the wrapper before `exec`, and `--silent`
means nothing is printed. The invocation is indistinguishable from the *subcommand*
failing: `./equin check` → no output, exit 1 reads as "checks failed", and the
natural next move is to hunt for a check failure that does not exist. It already cost two
agents a process-list diagnosis in one session, and it is a live hazard for `push`, where
"did my push land?" has no answer in the output.

This is **not** the build lock. `bin/build-lock.ts` behaves well — it waits with a cap and
throws naming the lock path and holder pid. The failure happens strictly earlier, in shell,
and never reaches that code.

### Measured on this worktree (bun 1.3.13)

| Observation | Result |
| --- | --- |
| Two concurrent `bun install` in one checkout, with link work pending | second exits **1** (`EEXIST … failed to link package: debug@4.4.3 (clonefileat)`) |
| Same race with `node_modules` already complete | both exit 0 |
| Warm `bun install --silent` (no changes) | **10–25 s**, 0.4 s user / ~5 % CPU — network-bound resolution |
| `bun install --silent --frozen-lockfile` | 1.4 s |
| Root `postinstall` (`run-provisions.ts`) alone | 0.6 s |

So: bun 1.3.13 has **no install mutex of its own** — concurrent installs in one checkout
race on `clonefileat` and one loses. The exact loser output varies (the reporter reproduced
zero bytes; here it was six `EEXIST` lines on stderr). The fix must not depend on which
failure mode fires — only on the fact that the install can fail at all.

### Root cause: three defects in one line of shell

1. **Unserialized.** The build's own install (`app-artifacts.ts:318`) runs *inside* the
   per-checkout `.build.lock`, so builds serialize among themselves. The wrapper's install
   runs *before the CLI exists*, outside every lock — so `./equin check` racing a
   `./equin build` is two unsynchronized installs in one `node_modules`. Install is
   guarded on one path and unguarded on the other.
2. **Unattributed.** `--silent` + `set -e` turns a failed *precondition* into a bare exit 1
   attributed to the *subcommand*.
3. **Unconditional.** 10–25 s of network wait on every invocation, and **twice per build**
   (wrapper, then stage 1 re-installs under the build lock).

## Design — one chokepoint: `ensureDeps()`

A single function owns "this checkout's `node_modules` is correct for its inputs". It is
freshness-gated (so the common case is ~10 ms and silent), serialized (so concurrent
CLI-mediated installs can't race), and loud (so failure names itself).

Freshness is what unlocks the other two: with no per-invocation noise there is no longer any
reason for `--silent`, so the install runs with **stdout/stderr passed through** — a failure
can never again be invisible.

### 1. `bin/ensure-deps.ts` (new)

Lives beside `bin/build-lock.ts`, and like it must be **runnable before `node_modules`
exists**: node builtins, relative imports, and `@plugins/*` aliases only (bun resolves
`@plugins/* → ./plugins/*` from `tsconfig.base.json` with no `node_modules` present).
Precedent for the constraint: the ALIAS-FREE docblock in
`plugins/framework/plugins/tooling/plugins/provision/scripts/run-provisions.ts`.

```ts
export async function ensureDeps(opts?: { log?: (s: string) => void }): Promise<void>
```

**Dep signature.** One walk of the repo (skipping `node_modules`), collecting `(mtimeMs,
size)` — the same fingerprint idiom as `infra/corpus-index` — of:

- `bun.lock`
- every workspace `package.json` (`workspaces: ["plugins/**"]`; 999 files, a few ms)
- every `plugins/**/provision/index.ts` plus
  `plugins/framework/plugins/tooling/plugins/provision/core/provision.generated.ts`
- `Bun.version`

Provision inputs are in the signature deliberately: provisions run as the root
`postinstall`, so a plugin that adds a `provision/index.ts` without touching any
`package.json` would otherwise be skipped forever. The stamp therefore means "`bun install`
**and** its postinstall provisions completed for exactly this input set".

`bun.lock` alone is not sufficient: editing a plugin's `package.json` without installing
leaves `bun.lock` stale, so the signature must include the `package.json` set to notice.

**Stamp.** `node_modules/.singularity-deps` (JSON: signature + timestamp). Inside
`node_modules` on purpose — the stamp can never outlive the thing it describes, so
`rm -rf node_modules` always forces a real install. Already gitignored.

**Flow.**

1. Compute the signature. Matches the stamp → **return immediately**: no lock, no output,
   no subprocess.
2. Differs → `acquireInstallLock(root)` = `acquireBuildLock(resolve(root, ".install.lock"))`
   from `./build-lock` (already generic — `acquireArtifactLock` is its second consumer). It
   brings the heartbeat, the dead-holder `ESRCH` steal, the "Another install is in progress;
   waiting..." notice, the wedged-holder throw naming the pid, and the cap. Add
   `**/.install.lock` to `.gitignore` beside `**/.build.lock`.
3. **Re-compute the signature under the lock** — the holder we waited on probably just did
   the install; if it now matches, write nothing and return.
4. Run `bun install` (no `--silent`) via `spawnPassthrough` from
   `@plugins/infra/plugins/spawn/core` — the sanctioned wedge-proof chokepoint, verified
   pre-install-safe (its transitive imports are `node:fs/os/path` +
   `@plugins/packages/plugins/spawn-priority/core`, itself `node:fs` only).
5. Exit 0 → write the stamp (signature recomputed *after* the install, since the install
   rewrites `bun.lock`). Nonzero → **throw** a message that names the phase unambiguously:

   ```
   singularity: dependency install FAILED (bun install exited 1) — your `check` never ran.
     Likely cause: another `bun install` is running in this checkout outside the CLI
     (bun 1.3.13 has no install mutex; concurrent installs race on clonefileat).
     Retry, or wait for the other install to finish.
   ```

   If bun produced no output at all, say so explicitly (`bun install printed nothing`)
   rather than leaving a blank gap — the silence itself becomes evidence.

Also give it an `import.meta.main` block so it is directly runnable.

### 2. `bin/index.ts` becomes a zero-dependency bootstrap

The whole point: **remove the pre-CLI shell step**, so there is nothing left that can die
before the CLI. `singularity` collapses to:

```sh
set -e
cd "$(dirname "$0")"
exec bun plugins/framework/plugins/cli/bin/index.ts "$@"
```

- Today's `bin/index.ts` body (commander program + `register*` + `runCli`) moves **verbatim**
  to `bin/cli.ts`.
- The new `bin/index.ts` has **no static import of any npm package** (`commander` is why the
  move is required — static imports hoist above any install):
  1. keep the existing orphan guard at the top (`installOrphanGuard` / `isOpCommand` —
     `orphan-guard.ts` has zero imports, and `process.argv[2]` is still the subcommand). It
     must arm *before* `ensureDeps`, so an orphaned install can't hold the install lock.
  2. `await ensureDeps()`, wrapped so a throw prints the message and `process.exit(1)`.
  3. `await import("./cli.ts")` — resolved only after `node_modules` is known good.

No ESM-freeze interaction: nothing in the bootstrap reaches a plugin barrel, and `cli.ts`
loads in the same pre-barrel state `index.ts` does today.

### 3. Both other install sites route through it

- **`bin/commands/internal/app-artifacts.ts`** stage 1: replace
  `await exec(["bun", "install"], root)` with `await ensureDeps(...)`, keeping the
  `bunInstall` / `build:setup` profiler span (it now usually records a fresh-skip).
  Because the bootstrap installed under the lock moments earlier, the build's second install
  collapses to a ~10 ms no-op — the 10–25 s double cost per build disappears.
  Lock ordering is one-way and must be documented in the docblock: **`.build.lock` →
  `.install.lock`**, never the reverse (nothing takes the build lock while holding the
  install lock), so no deadlock. Do *not* reuse `.build.lock` as the install lock: a
  `./equin check` would then block for an entire build.
- **`mise.toml`** setup task: `bun install --silent` → `bun plugins/framework/plugins/cli/bin/ensure-deps.ts`
  (its comment about avoiding a redundant second install stays true, and becomes structural).

### 4. Structural guard: a new check

`bin/index.ts` staying npm-free is exactly the kind of invariant that rots on the next edit
(one `import { program } from "commander"` and a fresh checkout crashes with an unresolved
module — the same class of silent-ish pre-CLI death). Add a plugin-contributed check
alongside the existing one in `plugins/framework/plugins/cli/check/index.ts`:

- **`cli:bootstrap-package-free`** — the transitive static-import closure of `bin/index.ts`
  must reach **no npm package** (node builtins and repo/alias modules only).
- Reuse that file's existing `repoClosure()` machinery verbatim: it already runs `Bun.build`
  with an `externalize-packages` `onResolve` plugin whose alias prefixes are *derived* from
  `tsconfig.base.json`. Extend it to also collect the specifiers it externalizes; the new
  check asserts every collected specifier is `node:`-prefixed (or in the node-builtin set).
  `Bun.build` computing the closure means the answer can't drift from what actually loads.
- Failure hint: "move the import into `cli.ts` — `index.ts` runs before `bun install`".

## Files

| File | Change |
| --- | --- |
| `plugins/framework/plugins/cli/bin/ensure-deps.ts` | **new** — signature, stamp, install lock, loud install |
| `plugins/framework/plugins/cli/bin/ensure-deps.test.ts` | **new** — `bun:test` |
| `plugins/framework/plugins/cli/bin/index.ts` | becomes the zero-dep bootstrap |
| `plugins/framework/plugins/cli/bin/cli.ts` | **new** — today's `index.ts` body, verbatim |
| `singularity` | drop `bun install --silent`; single `exec` |
| `plugins/framework/plugins/cli/bin/commands/internal/app-artifacts.ts` | stage 1 install → `ensureDeps`; document lock ordering |
| `mise.toml` | setup task calls `ensure-deps.ts` |
| `plugins/framework/plugins/cli/check/index.ts` | export both checks; add `cli:bootstrap-package-free` |
| `.gitignore` | add `**/.install.lock` |
| `plugins/framework/plugins/cli/CLAUDE.md` | document the chokepoint, the pre-install import constraint, and the lock order |

## Tests

`plugins/framework/plugins/cli/bin/ensure-deps.test.ts` (`bun:test`, beside the source,
mirroring `build-lock.test.ts`), over a temp fixture checkout:

- stamp matches signature → **no install spawned**, no lock file created
- touching a plugin `package.json` → install runs; touching `bun.lock` → install runs;
  adding a `provision/index.ts` → install runs; changing `Bun.version` in the stamp → install runs
- missing / malformed / absent-`node_modules` stamp → install runs
- install exits nonzero → throws, message contains the captured child output
- install exits nonzero with **no** output → throws, message says so explicitly
- signature re-check under the lock: pre-write a matching stamp while the lock is held →
  second caller returns without spawning

```bash
bun test plugins/framework/plugins/cli/bin/ensure-deps.test.ts
```

## Verification

1. **The original bug, before/after.** In a worktree:
   ```bash
   for p in debug ms picocolors chalk semver; do rm -rf node_modules/$p; done
   ( bun install >/dev/null 2>&1 & ) ; sleep 0.3
   ./equin check ; echo "EXIT=$?"
   ```
   Before: exit 1 with no attribution. After: either the checks actually run (the wrapper
   waited on the install lock, printing "Another install is in progress; waiting...") or a
   message that names dependency install as the failing phase — never a bare silent exit.
2. **Fresh-checkout path (the load-bearing one).** `rm -rf node_modules && ./equin check`
   must work end-to-end. This is the proof that `@plugins/*` alias resolution and the
   `spawn` import work with `node_modules` absent — the one assumption worth failing fast on.
   (If it does not, fall back to the walk-up-to-`workspaces` root helper and `Bun.spawnSync`,
   which `no-raw-bun-spawn` deliberately does not flag.)
3. **Cost.** `time ./equin check` twice in a row: the second is ~10 ms of install work
   instead of 10–25 s. `./equin build` no longer installs twice — confirm in the
   Debug → Profiling Gantt that the `bunInstall` span is now negligible.
4. **Checks + build.** `./equin check` (includes the new `cli:bootstrap-package-free`),
   then `./equin build` and confirm the app serves at
   `http://att-1785370247-fw9l.localhost:9000`.
5. **Guard bites.** Temporarily add `import { program } from "commander"` to `bin/index.ts`
   → `./equin check cli:bootstrap-package-free` must fail. Revert.

## As built (2026-07-30)

Implemented as designed, with four corrections found during implementation and review:

- **The fresh-skip path costs ~140 ms, not the ~10 ms estimated above** — ~126 ms of it the
  recursive walk (4044 dirs / 8379 files), ~1.5 ms the 1003 stats, plus ~15 ms module import
  and one `git rev-parse` when `root` defaults. Still 60–160× better than the 10–25 s install
  it replaces, so the walk was left correct rather than narrowed: `workspaces: ["plugins/**"]`
  admits a `package.json` at any depth, and missing one would silently skip a needed install.
- **The install lock spans exactly the install + stamp write**, released in a `finally`. An
  earlier draft held it for the process lifetime, which reintroduced the pathology this lock
  exists to avoid by another route (a stale-deps `check` would block on a concurrent *build's*
  whole runtime, and `capMs` 10–30 min would eventually convert that into a thrown timeout).
  Residual hazard — a dep-input edit *during* a build letting a second process relink
  underneath it — is accepted and stated in the code, since holding longer would not cover
  the relink source that actually occurs (a human's bare `bun install`, which takes no lock).
- The bootstrap's dynamic import is `await import("./cli")`, extensionless:
  `allowImportingTsExtensions` is off, so `"./cli.ts"` is a TS5097 error.
- `cli:bootstrap-package-free` measures with a `stopAtDynamicImport` boundary. Without it the
  deliberate `import("./cli")` drags commander's whole closure into the result and fails the
  check permanently while proving nothing. Known limit, documented in the check: a dynamic
  import placed *ahead* of `ensureDeps()` in the bootstrap's control flow is invisible to any
  static measurement — which is a further reason `bin/index.ts` stays tiny.
- The unit test's fixture declares `workspaces: ["packages/**"]`, not `plugins/**`: a
  `plugins/<name>/…` literal is read as a real plugin reference by `plugin-refs-resolve`
  (which failed on it), and deriving from a non-`plugins` root additionally proves
  `workspaceWalkRoots` does not assume the repo's own convention.

Verified: 16/16 unit tests; full `./equin check` green (75 checks); `./equin build`
deployed; the original race now yields a phase-attributed error with bun's own output visible;
a thrown `ensureDeps` exits **1** with one self-explanatory line; and `rm -rf node_modules &&
./equin check` works end-to-end in 8.4 s — the load-bearing proof that `@plugins/*`
resolution and the `spawn` primitive work with `node_modules` absent. Warm invocations are
~2.4 s total and print nothing about dependencies.

## Non-goals / residual risk

- **A human typing bare `bun install`** still bypasses the lock — bun has no install mutex,
  and we cannot add one to a command we do not own. The lock covers every CLI-mediated
  install, which is the collision that actually happens (build vs check). The new error
  message names this case explicitly so the next occurrence is a 5-second diagnosis.
- **`--frozen-lockfile` is not the fix.** It would *fail* rather than install when a
  `package.json` legitimately changed. Freshness-skip + a full install on change is the
  correct pairing; the network cost then only appears when deps actually changed.
- Not touching `build-lock.ts` itself, the build's `.build.lock`, or the admission valve.
