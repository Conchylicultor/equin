# Attributing an externally-signalled death, and saying so in the UI

## Context

On 2026-08-06 main's auto-build `build-1786028341655-x0pix4` (commit `862de5c72`) died
19 minutes in with exit 143. Establishing *why* took a multi-hour forensic dig through
host health logs, the macOS unified log, and finally every agent transcript on the box —
where the answer was found: an agent in worktree `att-1786028928-88pa` had been polling
main's build with `kill -0 33522` (correct), then at 15:18:21 ran a cleanup command that
dropped the `-0`:

```
rm -f …/tmp-write-page.ts …/tmp-diag.ts && kill 33522 2>/dev/null
```

Two defects made that dig necessary, and both are the subject of this plan.

**1. A killed build is indistinguishable from a build that failed its own checks.**
On SIGTERM the handler calls `process.exit(143)`; the exit hook at `build.ts:756` is
`process.on("exit", () => void finalizeBuild(false))` — it **discards the `code`
argument**, so `finalizeBuild` takes the `terminal === undefined` branch and writes
`status: "failed", exitCode: null` (`build.ts:731-737`). A build that fails its own
checks writes `status: "failed", exitCode: 1`. Nothing anywhere records that a signal
arrived, let alone which one. `resolveReceipt` never reports `interrupted` for this path
either, because the receipt did get rewritten.

**2. Nothing captures who sent the signal.** `process.on("SIGTERM", …)` gives no sender
information. That is a gap in the Node/Bun API, not in our code — but it is closable.

The outcome we want: a build that is killed says so, names its killer, and is never
mistaken for a code defect — in the receipt, in the verdict banner, and at
`/debug/build/r/<id>`.

### Constraint that shaped the design

Attribution must be **source-agnostic**. An earlier proposal — intercept `kill` in the
PreToolUse guards plugin — was rejected, correctly: it only ever sees senders we already
control. A human's `kill`, a supervisor, an IDE, or a resource governor must be named
just as well as one of our own agents.

### The decisive finding

`gateway/sigterm_darwin.go` **already does exactly this, in production, in this repo**:
`sigaction` with `SA_SIGINFO`, atomic store of `info->si_pid`, chain to the previously
installed handler, resolve the name with `ps -p <pid> -o comm=`. `mise.toml` pins
`go = "1.24"`, and `buildOrLocateGateway` (`plugins/infra/plugins/launcher/server/internal/boot.ts:398`)
runs `go build` from TypeScript on every dev box — and that file has `import "C"`, so
**cgo already invokes clang on C source as part of the existing pipeline.** This is not
"introducing native code to a repo that has none". It is making thirty lines that
already run here reachable from a Bun process.

One defect in that precedent must **not** be copied: `sigterm_darwin.go:21-24` chains
only when the previous handler is neither `SIG_DFL` nor `SIG_IGN`, and does nothing
otherwise. That is safe in Go (the runtime always installs a handler before `init()`),
but Bun installs **lazily on first `process.on(sig)`** — so a tap armed too early would
see `SIG_DFL` and **silently swallow the signal**, leaving a build that ignores SIGTERM
forever. The `SIG_DFL` arm must restore the default disposition and re-raise.

## Verified platform facts

Established on this machine; they close off the alternatives.

- **`sigwaitinfo`/`sigtimedwait` do not exist on darwin.** Only `sigwait`
  (`$SDK/usr/include/signal.h:104`), which yields the signal number without `siginfo_t`.
  The "block the signal and accept it on a dedicated thread" design is unavailable.
  (It is also not viable on linux: Bun has JSC, io and bmalloc threads running before
  user JS, and `pthread_sigmask` only affects the calling thread.)
- **kqueue `EVFILT_SIGNAL` carries no sender identity** — `ident` is the signo, `data` a
  delivery count.
- **Bun installs its signal handler lazily**, on the first `process.on(sig)`, as a plain
  `void(int)` with `SA_RESTART` and **without** `SA_SIGINFO`; it does not re-`sigaction`
  for later listeners, and `removeAllListeners` restores `SIG_DFL`.
- **`JSCallback` is out.** Non-threadsafe means entering JSC from a signal handler
  (JSLock / bmalloc reentrancy — fine when idle, which is exactly not a running build);
  `threadsafe: true` defers the call until after the handler returns, when the
  `siginfo_t*` points into an unwound signal stack — use-after-free by construction.
  There is no third setting, and `JSCallback` appears nowhere in this repo today.
- **`si_code` on darwin does not match its own header.** `sys/signal.h:325` declares
  `SI_USER == 0x10001`; XNU delivers `1`. Never compare against `SI_USER`. The portable
  discriminator is **`si_pid !== 0` ⟹ a process sent it; `si_pid === 0` ⟹ kernel- or
  tty-generated** (an interactive Ctrl-C lands here, which is itself worth distinguishing).
- **`siginfo_t` on darwin arm64**: `si_pid` at offset 12, `si_uid` at 16, `sizeof` 104
  (compiler-asserted). Recorded for review only — the design never reads these offsets
  from TypeScript.
- **SIGKILL/SIGSTOP are uncatchable.** No in-process mechanism can ever attribute them.
  The existing `resolveReceipt` → `interrupted` (receipt left `running`, dead pid) stays
  the only signal there, and that is correct.

## Design

### Step 0 — make "killed" a fact, with no native code

Independent of everything below, lands first, and is what you keep if the rest is ever
descoped. It converts *"indistinguishable on disk"* into *"unambiguously killed by
SIGTERM, sender unknown"*.

- `build.ts:756` → `process.on("exit", (code) => void finalizeBuild(false, { code }))`,
  and `finalizeBuild` records the real exit code instead of `null`.
- Add `signal?: string | null` to `BuildReceipt` (`bin/build-receipt.ts`), set from the
  signal handler.
- `fallbackVerdict` (`bin/build-output.ts:103`) takes an optional termination fact. The
  `emitted === null && code !== 0` branch stops saying
  `BUILD FAILED — aborted before completing (exit 143)` and says
  `BUILD ABORTED — terminated by SIGTERM` (plus attribution once Step 2 lands). It stays
  a pure function, so it stays unit-testable as it is today.

### Step 1 — collapse the triplicated signal map

`[["SIGINT",130],["SIGTERM",143],["SIGHUP",129],["SIGQUIT",131]]` is duplicated verbatim,
with near-identical comments, in `build.ts:775`, `check.ts:201` and `push.ts:287`. There
is no shared owner. Extract `installFatalSignalExit(onSignal?)` into
`plugins/framework/plugins/cli/bin/fatal-signals.ts` and route all three through it.
No behaviour change — this exists so Step 3 has one seam to arm rather than three.

### Step 2 — `signal-origin`: a native SA_SIGINFO tap

New leaf plugin `plugins/packages/plugins/signal-origin/`, sized and shaped like
`plugins/packages/plugins/flock/` (which the CLI already imports directly —
`bin/build-lock.ts:3`). `bun:ffi` is a builtin, so the `bin/index.ts` no-npm-imports
rule is satisfied.

```
native/signal-origin.c      the tap (darwin / linux #ifdef)
core/types.ts               SignalOrigin type + pure formatSignalOrigin()
server/internal/…           ensureTapLibrary, lazy dlopen, arm/read
server/index.ts             barrel
CLAUDE.md
```

Three exported symbols:

```c
int      so_install(int signo);                        // arm one signal; 0 = ok
int      so_snapshot(int signo, char *buf, int cap);   // slot → JSON; NEVER in-handler
uint32_t so_layout_version(void);                      // dylib/TS skew guard
```

**The boundary decision that matters: C owns the struct *and* its serialization;
TypeScript sees only a JSON string.** `so_snapshot` runs in normal context (from the
`process.on(sig)` listener or the exit hook), so it may `snprintf`. Consequently no
`siginfo_t` offset ever appears in TS, the darwin/linux layout difference is invisible
above the FFI line, and there is no `phys-footprint.ts`-style "offset 72" comment to rot.
`so_layout_version()` fails the arm on a stale cached dylib.

Handler body — async-signal-safe by inspection (static-BSS stores and bounded syscalls
only; no `malloc`, no locks, no JS), behind a seqlock so a reader can never see a torn
slot:

1. Save `errno`.
2. Store `si_signo`, `si_code` (raw), `si_pid`, `si_uid`, `getppid()` **at signal time**,
   `CLOCK_REALTIME` + `CLOCK_MONOTONIC_RAW`, and a hit counter.
3. If `si_pid != 0`, walk the sender's ancestry ≤8 levels — darwin
   `proc_pidinfo(PROC_PIDT_SHORTBSDINFO)` → `{pid, ppid, uid, comm}`; linux
   `/proc/<pid>/stat`.
4. `proc_pidpath(si_pid)` / `readlink("/proc/<pid>/exe")` for the sender's full path;
   tolerate `EPERM` (cross-uid without root) — `comm` still resolves for any pid.
5. Restore `errno`, then chain: `SA_SIGINFO` → `sa_sigaction`; real `sa_handler` →
   call it; `SIG_IGN` → return; **`SIG_DFL` → restore default and `raise(sig)`**.

Ancestry is captured **in the handler, not afterwards**, because the `/bin/kill` that
sent the signal usually exits within milliseconds — by the time any JS runs the pid is
often already reaped. That inversion is the whole reason this answers the question the
2026-08-06 dig had to answer by hand. Keep the handler's syscall budget capped (~10) and
resist adding `KERN_PROCARGS2` argv capture to it later.

**Build and shipping.** Not a `provision/` entry — that runner fails loud, so a dev box
without CLT would stop being able to `bun install`. Instead: lazy, content-addressed,
host-global, mirroring `ensure-deps.ts`'s freshness stamp.

```
~/.singularity/native/signal-origin-<sha8-of-source>-<arch>.dylib
```

`ensureTapLibrary()` hashes the `.c`, `existsSync` on the target (the only steady-state
cost), and on a miss runs `cc -O2 -fPIC -dynamiclib` to a tmp path then `renameSync`.
Content-addressing makes concurrent compiles from parallel worktrees harmless — identical
bytes, last rename wins, no lock. Editing the `.c` rebuilds automatically.

*Rejected:* `go build -buildmode=c-shared` to reuse the gateway's C verbatim — the Go
runtime installs its own handlers at `dlopen` time and would fight Bun's for the same
dispositions. Plain `cc` on plain C imports no second runtime into the dying process.

**Fail-open, quietly.** `armSignalOrigin()` returns `false` and the build proceeds
unchanged if `cc` is absent, the compile fails, `dlopen` fails, the layout version
mismatches, or `so_install` is non-zero. It does **not** `console.error` — a banner on
every build in a toolchain-less environment would be noise in the transcript this
feature exists to keep clean. It appends one `{armed:false, reason}` line to the sink, so
the *absence* of attribution is itself recorded. Escape hatch
`SINGULARITY_NO_SIGNAL_ORIGIN=1`, mirroring `SINGULARITY_NO_SPAWN_PRIORITY`.

### Step 3 — wiring, and the ordering that is load-bearing

```
installFatalSignalExit():
  1. for (sig, code) of MAP: process.on(sig, …)   // ← Bun installs its handler HERE
  2. armSignalOrigin([...])                        // ← captures Bun's handler as oldact
  3. sigaction(sig, NULL, &cur); assert cur.handler === tap
```

Step 1 **before** step 2 is required: Bun installs lazily and does not chain, so arming
first would be silently overwritten. Step 3 is a cheap self-check that would catch a
future Bun that re-`sigaction`s.

The death path keeps its current shape exactly — the tap adds no exit handler and
reorders nothing:

```
SIGTERM
 → [native tap] record si_pid/si_uid/si_code/ancestry/self-ppid → chain
 → [Bun handler] → process.on("SIGTERM") → process.exit(143)
 → exit hook #1 (build.ts:756)  finalizeBuild → receipt (+ signal + real code)
 → exit hook #2 (installVerdictGuard)         → verdict banner, last
```

`readSignalOrigin()` is a lazy pure read consulted *inside* `finalizeBuild` and
`fallbackVerdict` — strictly better than pushing from the handler, since a signal that
arrives while the process is blocked in a synchronous FFI call still leaves the slot
populated for whichever exit path runs. Everything on this path stays **synchronous file
I/O only**; no `await` is introduced (a wedged pool would turn a clean termination into a
hang).

### Step 4 — one build-status source of truth

The exit-code→status mapping is currently duplicated across three sites and is already
inconsistent: `exitCode === -1` renders "Superseded" in `build-info.tsx`'s `StatusBadge`
but "canceled" in `build-popover-content.tsx`'s `statusOf`, and `build-fix`'s
`useBuildFailed` excludes only `0` and `75` — so **a hard-killed run today wrongly offers
"launch an agent to investigate"** a defect that does not exist. Adding a fourth state to
three copies would deepen that.

New `plugins/build/plugins/build-status/`, mirroring
`plugins/tasks/plugins/attempt-status/` (the established single-source pattern):

```ts
// core — one total function, no call site branches on exit codes again
buildStatusOf(run): "running" | "success" | "superseded" | "interrupted" | "killed" | "failed"
  !finishedAt                    → running
  exitCode === 0                 → success
  exitCode === BUILD_EXIT_SUPERSEDED (75) → superseded
  exitCode === -1                → interrupted   // hard-killed, no artifact
  exitCode > 128                 → killed        // 128 + signo, the POSIX convention
  else                           → failed
BUILD_STATUS_META: label, badge variant, dot class
// web
<BuildStatusBadge run={run}/>
```

`killed` and `interrupted` render **muted, not destructive** — the same treatment
`superseded` already gets, and for the same reason: neither is a code defect, and neither
should draw the eye the way a real failure must. No new exit-code constant is needed;
`>128` is the standard shell encoding the signal handlers already produce.

Route all three consumers through it: `build-info`'s `StatusBadge`,
`build-popover-content`'s `StatusDot`/`statusOf`, and `build-fix`'s `useBuildFailed`
(which becomes `buildStatusOf(run) === "failed"` — fixing the wrong offer as a
by-product).

### Step 5 — recording and surfacing

Four surfaces, each already precedented:

1. **Host-global JSONL sink** — `defineFileSink({ id: "signal-origin", path:
   join(SINGULARITY_DIR, "signal-origin.jsonl") })`, appended synchronously from the exit
   hook. Host-global for the reason `build-progress.ts:11` already gives: *an incident is
   investigated from whichever shell is free, not from the wedged worktree.* This is the
   only record for `check`/`push`, and for a build killed **before** it took the lock
   (where `receipt` is still `null` by design and must stay so).
2. **The deploy receipt** — `termination?: SignalOrigin | null` on `BuildReceipt`.
   `resolveReceipt` untouched. `interruptedPredecessorWarning` gains the attribution
   line, so the *next* op in the worktree announces not just "the previous build never
   completed" but who ended it.
3. **Per-run endpoint** — `GET /api/build/runs/:id/termination`, `readFileSync` on the
   JSONL filtered by `buildId`. Identical shape to
   `build-profiling/server/internal/handle-build-run-profiling.ts`. Explicitly **not** a
   `build_runs` column: that would force a migration *and* an `await` on the death path.
4. **The run detail UI** — `build-info` renders the `killed` badge plus the attribution:

   ```
   Status    ● Killed externally
   Signal    SIGTERM from pid 41234  /bin/kill
             ← 41198 bun (att-1786028928-88pa)  ← 872 tmux  ← 1 launchd
             uid 501 · 15:18:25.236Z · during step "checks"
   ```

   and `run-build.ts` gains a `killed` notification arm (`variant: "info"`, not
   `"error"`) beside the existing `BUILD_EXIT_SUPERSEDED` one.

## Files

| Path | Change |
|---|---|
| `plugins/framework/plugins/cli/bin/commands/build.ts` | `:756` pass `code` to `finalizeBuild`; `:720-752` record code + signal + termination; `:775` → shared helper |
| `plugins/framework/plugins/cli/bin/build-receipt.ts` | `signal` + `termination` on `BuildReceipt`; attribution in `interruptedPredecessorWarning` |
| `plugins/framework/plugins/cli/bin/build-output.ts` | `fallbackVerdict` takes the termination fact; new `BUILD ABORTED` wording |
| `plugins/framework/plugins/cli/bin/fatal-signals.ts` | **new** — `installFatalSignalExit`, arms the tap |
| `plugins/framework/plugins/cli/bin/commands/{check,push}.ts` | route through the shared helper |
| `plugins/packages/plugins/signal-origin/**` | **new leaf plugin** — `.c`, FFI, types, barrel, CLAUDE.md |
| `plugins/build/plugins/build-status/**` | **new** — `buildStatusOf`, `BUILD_STATUS_META`, `BuildStatusBadge` |
| `plugins/build/plugins/build-info/web/components/build-info.tsx` | use the shared badge; render attribution |
| `plugins/build/web/components/build-popover-content.tsx` | use the shared status |
| `plugins/build/plugins/build-fix/web/components/build-fix-section.tsx` | `useBuildFailed` → `buildStatusOf(run) === "failed"` |
| `plugins/build/plugins/build-logs/{core,server,web}` | termination endpoint + read |
| `plugins/build/server/internal/run-build.ts` | `killed` notification arm |

## Verification

1. **Handler correctness in isolation** — a `bun:test` beside the plugin that spawns a
   sleeper with the tap armed, signals it from a known child (`/bin/sh -c 'exec /bin/kill
   -TERM <pid>'`), and asserts the snapshot's `senderPid` equals that child's pid and
   `ancestry[0].comm` is `kill`. Also assert the `SIG_DFL` arm: arm before any
   `process.on`, signal, and confirm the process still dies (guards against the swallow
   the gateway precedent would have caused).
2. **Chaining not broken** — assert `process.on("SIGTERM")` still fires and the exit code
   is still 143 with the tap armed. This is the regression that matters most.
3. **Fail-open** — run with `SINGULARITY_NO_SIGNAL_ORIGIN=1` and with a bogus `CC`;
   assert the build completes normally and one `{armed:false}` line lands in the sink.
4. **End-to-end, reproducing the incident** — `./equin build` in this worktree,
   `kill <pid>` from another shell mid-checks, then assert: the receipt carries
   `status:"failed"`, the real exit code and the signal; the verdict banner names the
   sender; `~/.singularity/signal-origin.jsonl` has the record; and
   `/debug/build/r/<id>` shows a **muted "Killed externally"** badge with the ancestry —
   and offers **no** build-fix button. Drive the UI with
   `plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts`.
5. **Status collapse is behaviour-preserving** — `bun:test` on `buildStatusOf` covering
   `0 / 1 / 75 / -1 / 143 / null-finishedAt`, and confirm the popover and detail pane now
   agree on `-1` (they disagree today).
6. `./equin check` and `./equin build`.

## Explicitly out of scope

- **SIGKILL attribution.** Uncatchable; `resolveReceipt`'s `interrupted` remains the only
  signal. A kqueue `EVFILT_PROC` / `NOTE_EXIT_DETAIL` watcher could later distinguish
  jetsam/OOM from a plain kill, but it answers "what", never "who".
- **Blocking the kill.** A guard that refuses to signal a foreign op pid is a separate,
  complementary change; this plan is attribution only.
- **Moving the arm into `bin/index.ts`.** Arming at today's `build.ts:775` position keeps
  signal coverage byte-identical to current behaviour and leaves no regression surface.
  Covering the earlier `ensureDeps` window is a follow-up once the tap has proven itself.
- The two tasks already filed from this investigation: the shared `check.log` path
  (`task-1786053763482-dp8dcn`) and convergence treating a killed build as converged.
