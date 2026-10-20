# signal-origin

A native `SA_SIGINFO` tap that records **who** sent a fatal signal, reachable
from Bun via `bun:ffi`. `process.on("SIGTERM", …)` tells you a signal arrived
and nothing else; the kernel knew the sender (`siginfo_t.si_pid`) all along.

- `signalOriginShim` (`deps/` barrel) — the compiled C shim, a `build`-kind
  dependency (`infra/deps/plugins/build`): identity = the `native/` source's
  hash + `$CC --version` + platform/arch, built into the deps cache
- `armSignalOrigin(ready, signos)` → `{armed:true,…} | {armed:false, reason}` —
  takes the shim's `Ready`, so arming without building is a type error
- `readSignalOrigin(signo)` → `SignalOrigin | null` — synchronous, safe from an exit hook
- `formatSignalOrigin(origin)` — pure, in `core/`

Design + the incident that produced it:
`research/2026-08-07-global-signal-origin-attribution.md`. The precedent was the
gateway's cgo `sigterm_darwin.go`, since removed so the gateway builds as pure Go
(no C toolchain at install) — this tap is the only one left.

## Four contracts

**1. `so_handler` is async-signal-safe by inspection.** Static-BSS stores and
bounded syscalls only — no `malloc`, no locks, no stdio, no `strlen`/`snprintf`,
no JS; `errno` saved and restored. Syscall budget ~10. Nothing may be added there
that allocates or takes a lock; in particular **do not add `KERN_PROCARGS2` argv
capture** — a sysctl round-trip with a caller-sized buffer blows the budget. The
slot is written behind a seqlock, so a reader never sees a torn slot.

**2. C owns the struct AND its serialization.** `so_snapshot` runs in normal
context (never in-handler) so it may format freely, and it is the only thing that
touches the layout. TS reads a `char*` + an `int` and calls `JSON.parse`. So **no
`siginfo_t` offset ever appears in TypeScript** and the darwin/linux layout
difference stays invisible above the FFI line. Keep it that way.
`so_layout_version()` refuses the arm on dylib/TS skew.

**3. The `SIG_DFL` arm must restore-and-`raise`.** The gateway precedent chains
only when the previous handler is neither `SIG_DFL` nor `SIG_IGN` — safe in Go,
whose runtime always installs first. **Bun installs lazily, on the first
`process.on(sig)`**, so a tap armed before that captures `SIG_DFL` and the
"do nothing" arm would *silently swallow the signal*: a build that can never be
killed. Tested.

**4. Arm AFTER `process.on`.** Bun installs lazily and does not re-`sigaction`
for later listeners, so arming first is silently overwritten and the tap never
sees a delivery.

## Things that look wrong and are not

- **`si_code` is a breadcrumb, never a discriminator.** darwin's
  `<sys/signal.h>` declares `SI_USER == 0x10001`; XNU delivers `1` (and `0` for a
  sibling's `kill(2)`, observed here). The portable discriminator is
  `senderPid !== 0` ⟹ a process sent it; `senderPid === 0` ⟹ kernel/tty —
  where an interactive Ctrl-C lands.
- **The ancestry is walked inside the handler**, because the `/bin/kill` that
  sent the signal is usually reaped within milliseconds. It does not always win:
  when the sender's parent reaps it before this process is scheduled, the first
  read returns `ESRCH` and `ancestryErrno` records that. `senderPid` still holds.
  `ancestryErrno` exists so an empty `ancestry` is never ambiguous between
  "could not read" and "no forebears".
- **Fails open and PRINTS NOTHING.** A banner on every build in a
  toolchain-less environment would be noise in exactly the transcript this
  feature exists to keep clean. The caller records the `reason`. Escape hatch
  `SINGULARITY_NO_SIGNAL_ORIGIN=1` (`signalOriginDisabled()`: no arm, and the
  tap does not ensure the shim either).
- **The shim is a dependency, not a compile inside the arm.** `op-runtime`'s
  `signalOriginTap` awaits `ensureDep(signalOriginShim, cliExecContext())`
  before installing the listeners, then arms synchronously in `afterInstall`.
  An install failure (no compiler, a compile error) is fail-open: it becomes
  the `arm-failed` sink line, and the dependency reads `failed` in
  `./singularity deps list` / Settings → Dependencies instead of being silent.
  The declaration says `admission: { none }`: one tiny compile, awaited on the
  way INTO an op, must not queue behind the background lane for a host grant
  (see `DepSource.admission`). Parallel worktrees on one identity share one
  build under the engine's lock. A release bundle ships no source and no `cc`,
  so the identity cannot be derived and the tap is unarmed there, as before
  (sealed installs are the follow-up that fixes it).
- **`core/` is the FFI-free half** — a surface that only renders a recorded
  origin must not pay a `bun:ffi` dependency. Same split as `spawn-priority`.
- **`server/internal/signal-origin.fixture.ts` is in the repo, not `/tmp`.** A
  handler is only observable from outside its own process, so every test needs a
  real child — and Bun resolves the `@plugins/*` alias relative to the importing
  file's project, so a script in `/tmp` cannot import this plugin at all.

Out of scope: **SIGKILL/SIGSTOP** are uncatchable, so nothing in-process can ever
name their sender.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Native SA_SIGINFO signal tap: records WHO sent a fatal signal (sender pid/uid, executable path, and the sender's ancestry captured inside the handler before it is reaped) and chains to the previously installed handler. armSignalOrigin(ready, signos) arms from the compiled shim (the signal-origin-shim dependency, a build kind declared in its deps barrel) and fails open and quiet; readSignalOrigin is a synchronous pure read safe from an exit hook.
- Deps:
  - Uses:
    - `infra/deps.defineDep`
    - `infra/deps/build.build`
  - Exports (values): `signalOriginShim`
- Cross-plugin:
  - Imported by: `build/build-termination`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `server/internal/signal-origin.fixture.ts`, `server/internal/signal-origin.ts` (debt)
- Server:
  - Exports (types): `SignalOriginArmResult`
  - Exports (values):
    - `armSignalOrigin`
    - `readSignalOrigin`
    - `signalOriginDisabled`
- Core:
  - Exports (types):
    - `SignalOrigin`
    - `SignalOriginProc`
  - Exports (values):
    - `formatSignalOrigin`
    - `signalName`
- Structure:
  - Non-standard folders: `native/`
- Sub-plugins:
  - **`sink`**

<!-- AUTOGENERATED:END -->
