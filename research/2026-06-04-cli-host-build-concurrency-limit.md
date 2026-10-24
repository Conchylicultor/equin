# Host-wide concurrency limit for `build` / `push` check suites

## Context

`./equin build` and `./equin push` each run a CPU/RAM-heavy work
section — ESLint, several `tsc --noEmit` targets, and the Vite bundle — and
there is **no host-wide cap** on how many run at once. With ~8 active worktrees
each kicking these off, the machine thrashes: dozens of multi-GB `eslint`/`tsc`
processes starve each other, stretching a normally-fast checks run 10–50×. Cost
grows *superlinearly* with worktree count, and the slow checks are the main
driver of the existing push-lock contention.

Today's coordination:

- `push` already serializes **all** pushes host-wide via a `flock(2)` advisory
  lock on `~/.singularity/push.lock` (`push.ts:195-226`). At most one push runs
  at a time. Its checks run via a spawned `bun … check` subprocess
  (`runChecksSubprocess`, `push.ts:38`), inside that lock.
- `build` has only a *per-worktree* symlink mutex (`acquireBuildLock`,
  `build.ts:118`) — it does **not** limit cross-worktree parallelism. Its heavy
  section is a `Promise.all` of checks + per-target `tsc` + Vite
  (`build.ts:712-772`), fully unbounded across worktrees. **This is the main
  offender.**

`flock` is the right primitive here (not POSIX `sem_open`): it **auto-releases
when the fd closes or the process dies**, so a SIGKILLed agent — which happens
routinely — never leaks a slot. The codebase already relies on this for
`push.lock` and on PID-probing for the build symlink.

## Goal & policy (decided)

Introduce a crash-safe, host-wide concurrency gate around the heavy section of
`build` and the check suite, with this priority policy:

1. **Main-branch build is exempt** — `build` on `branch === "main"` (the
   auto-build of the `singularity`/main namespace, run with `--allow-main`)
   **never waits**. It bypasses the gate entirely.
2. **Everything else is capped** — agent-worktree builds and all pushes draw
   from a bounded pool whose size is independent of worktree count.
3. **Push > build** — a push's checks must never queue behind agent builds.

### Slot layout

`flock` has no native priority and can't efficiently "wake on *any* free slot,"
so rather than a fragile reader/writer dance we use a **dedicated reserved push
slot** next to a shared build pool. Because `push.lock` already serializes
pushes to **one at a time**, a single reserved slot means a push *never* queues
behind builds — the strongest form of "push > build" — with zero added latency
and minimal code.

- **Build pool**: `N = max(1, floor(cpuCount / 4))` flock files
  `~/.singularity/build-slots/build-{0..N-1}.lock`. Override via
  `SINGULARITY_BUILD_CONCURRENCY`. (Each heavy job itself spawns ~8 subprocesses
  — 1 eslint + ~6 tsc + 1 vite — so `cpuCount/4` keeps total bounded without
  over-throttling. On a 12-core box: `N = 3`.)
- **Push slot**: 1 reserved flock file `~/.singularity/build-slots/push-0.lock`.
- **Exempt**: main-branch build takes no slot.

Worst-case host ceiling: `N` builds + 1 push + 1 main-build = `N + 2` heavy
jobs, vs. the unbounded `8 × ...` today. `N` is tunable down if still hot.

## Implementation

### 1. New module: `plugins/framework/plugins/cli/bin/host-semaphore.ts`

Sibling of `paths.ts` / `push-profiler.ts`. Mirrors the `flock`-via-FFI pattern
from `push.ts`.

```ts
import { dlopen } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { SINGULARITY_DIR } from "./paths";

const SLOTS_DIR = join(SINGULARITY_DIR, "build-slots");
const { symbols: ffi } = dlopen(
  process.platform === "darwin" ? "libc.dylib" : "libc.so.6",
  { flock: { args: ["i32", "i32"], returns: "i32" } },
);
const LOCK_EX = 2;
const LOCK_NB = 4;

function buildSlotCount(): number {
  const env = process.env.SINGULARITY_BUILD_CONCURRENCY;
  if (env) { const n = parseInt(env, 10); if (n > 0) return n; }
  return Math.max(1, Math.floor(cpus().length / 4));
}

export type HostSlotKind = "exempt" | "build" | "push";
export interface HostSlotHooks { onWaitStart?: () => void; onAcquired?: () => void; }

/**
 * Crash-safe host-wide concurrency gate. `exempt` runs immediately; `push` uses
 * the single reserved push slot; `build` shares the N-slot build pool. flock
 * auto-releases on fd close / process death (SIGKILL-safe), mirroring push.lock.
 */
export async function withHostSlot<T>(
  kind: HostSlotKind,
  fn: () => Promise<T>,
  hooks?: HostSlotHooks,
): Promise<T> {
  if (kind === "exempt") { hooks?.onAcquired?.(); return await fn(); }

  mkdirSync(SLOTS_DIR, { recursive: true });
  const files = kind === "push"
    ? [join(SLOTS_DIR, "push-0.lock")]
    : Array.from({ length: buildSlotCount() }, (_, i) => join(SLOTS_DIR, `build-${i}.lock`));
  const fds = files.map((f) => openSync(f, "w"));

  try {
    let acquired = false;
    for (const fd of fds) {
      if (ffi.flock(fd, LOCK_EX | LOCK_NB) === 0) { acquired = true; break; }
    }
    if (!acquired) {
      hooks?.onWaitStart?.();
      // All slots busy → block on one (pid-hashed for spread); take it on wake.
      ffi.flock(fds[process.pid % fds.length]!, LOCK_EX);
    }
    hooks?.onAcquired?.();
    return await fn();
  } finally {
    for (const fd of fds) closeSync(fd); // releases whichever slot we hold
  }
}
```

Concurrency is strictly bounded: each flock file admits one holder, so builds ≤
`N`, pushes ≤ 1. Closing all fds in `finally` releases the held slot; process
death does the same via the OS.

### 2. `build.ts` — gate the heavy section

`branch` is already computed at `build.ts:525`. Wrap the `Promise.all` heavy
block (`build.ts:712-772`) in `withHostSlot`:

```ts
const slotKind = branch === "main" ? "exempt" : "build";
const stepResults = await withHostSlot(slotKind, async () => {
  const parallel: Array<Promise<StepResult>> = [];
  // ... existing checks + runtimeTargets tsc + vite pushes (lines 714-770) ...
  return await Promise.all(parallel);
}, {
  onWaitStart: () => console.log("Waiting for a build slot (machine busy)..."),
});
```

Surface the queue wait on the existing build Gantt (`debug/profiling/build`):
open a `buildProfilerStart("buildSlotWait", "build:queue", "waiting for build slot")`
span in `onWaitStart` and end it in `onAcquired` (same `buildProfilerStart`
helper already imported at `build.ts:20`).

### 3. `check.ts` command — gate direct checks and push checks

The `check` command (`check.ts`) is the path used by **both** direct
`./equin check` and push (via `runChecksSubprocess`). Distinguish them
with an env flag set by push:

```ts
const kind: HostSlotKind = process.env.SINGULARITY_PUSH_CHECK ? "push" : "build";
const ok = await withHostSlot(kind, () =>
  runChecks(checks.length > 0 ? checks : undefined),
);
```

### 4. `push.ts` — tag the check subprocess as a push

In `runChecksSubprocess` (`push.ts:38-45`), pass the flag so the subprocess
takes the reserved push slot instead of a build slot:

```ts
const proc = Bun.spawn(["bun", "plugins/framework/plugins/cli/bin/index.ts", "check"], {
  cwd: root,
  env: { ...process.env, SINGULARITY_PUSH_CHECK: "1" },
  stdout: "inherit",
  stderr: "inherit",
});
```

No change to `push.lock` — pushes stay serialized to 1, and that single push now
also holds the reserved push slot during its checks (so it's counted in the host
ceiling but never blocked by builds).

### No double-gating

`build` acquires **one** slot at the command level; its in-process `runChecks`
does *not* go through the `check` command, so it never re-acquires. Direct
`check` and push's `check` subprocess each acquire once. No nesting, no
lock-ordering cycle (build never touches `push.lock`; push never touches build
slots except the dedicated push slot).

## Files to touch

| File | Change |
| --- | --- |
| `plugins/framework/plugins/cli/bin/host-semaphore.ts` | **new** — `withHostSlot` + `HostSlotKind` |
| `plugins/framework/plugins/cli/bin/commands/build.ts` | wrap heavy `Promise.all` (712-772) in `withHostSlot`; branch→kind; queue-wait profiler span |
| `plugins/framework/plugins/cli/bin/commands/check.ts` | wrap `runChecks` in `withHostSlot`; kind from `SINGULARITY_PUSH_CHECK` |
| `plugins/framework/plugins/cli/bin/commands/push.ts` | set `SINGULARITY_PUSH_CHECK=1` env in `runChecksSubprocess` |

No schema, no plugin barrels, no migrations.

## Verification

1. **Build & self-check**: `./equin build` in this worktree, confirm it
   still deploys and `./equin check` passes (including
   `plugin-boundaries`, `eslint`).
2. **Cap holds under load**: in several worktrees, fire `./equin build`
   simultaneously (e.g. `for d in <worktrees>; do (cd $d && ./equin build &); done`).
   In another shell, `ps -A -o command | grep -E 'bin/(tsc|eslint)'` and confirm
   concurrent heavy jobs stay ≈ `N` (default 3 on a 12-core box), not 8×. Repeat
   with `SINGULARITY_BUILD_CONCURRENCY=1` and confirm strict serialization.
3. **Slot files**: while builds queue, `ls ~/.singularity/build-slots/` shows
   `build-{0..N-1}.lock` (+ `push-0.lock` once a push runs).
4. **Push priority**: with all build slots saturated, run `./equin push`
   from another worktree; its check phase should start immediately (reserved push
   slot), not wait for builds. Confirm via push timing / it not printing the wait
   line.
5. **Main exempt**: `./equin build --allow-main` on the main worktree while
   the build pool is saturated → starts immediately, no "waiting for a build
   slot" line.
6. **Crash-safety**: SIGKILL a building agent mid-build; confirm a queued build
   then proceeds (flock auto-released — no stale lock, unlike a leaked file).
7. **Gantt**: open the Debug → Profiling build Gantt and confirm queued builds
   show a `buildSlotWait` span before their work.
