# stack-sampler

The one owner of `bun:jsc`'s JSC sampling profiler. It answers "which code was
on this thread just now?" from stack samples. It keeps answering while the
thread is blocked, because the sampler runs on its own thread.

**Bun-only, in `core/`, with no cross-plugin imports.** A CLI process (the check
runner) and a server backend (health-monitor) can both import it. Never import
it from `web/`.

```ts
import { claimStackSampler, frameKey } from "@plugins/infra/plugins/stack-sampler/core";

const sampler = claimStackSampler("health-monitor"); // arms the profiler (once, forever)
for (const sample of sampler.drain()) {              // each tick
  frameKey(sample.frames[0]!, shorten);              // "fn @ a/b.ts:12" | "fn [LLInt]"
}
```

## One owner per process

`claimStackSampler(owner)` arms the profiler on its first call and returns the
reader. The **same** owner again gets the same handle. A **different** owner in
the same process **throws**, naming both.

The reason: every read of `samplingProfilerStackTraces()` **empties** JSC's
buffer. Two readers would each get part of the samples, and each profile would
look complete. A throw at claim time is the loud version of that silent bug. A
second consumer goes through the existing owner, never a second reader.

**Tests never claim the real sampler under a test owner.** `bun test` runs every
file in one process, so such a claim would make health-monitor's claim throw, or
not, depending on file order. The claim logic is the internal
`createStackSamplerClaim(backend)`, which the tests drive with a fake backend.
The only real claim in a test is health-monitor's end-to-end capture, under its
production owner name. A consumer takes a `StackSampler` (`{ drain() }`) as a
parameter, so its own tests can inject samples.

## The bun:jsc API (Bun 1.3.x, measured)

- **No stop.** Arming lasts for the process. A consumer that is done stops
  draining, and the sampler thread idles.
- **The argument is a directory.** `startSamplingProfiler(optionalDirectory?)`
  takes an output directory, not an interval. A number means nothing, so it is
  called with none.
- **A read empties the buffer.** Draining once per timer tick lines the samples
  up with that tick's window, so after a block the late tick gets exactly the
  block's samples.
- **The rate varies.** ~40 Hz in a CLI probe, ~230 Hz on the main backend, and
  the returned `interval` (0.001) matches neither. Derive the rate from
  samples ÷ window.
- **An idle thread yields no traces**, not empty ones. So a sample count
  measures busy time, not wall time.
- **Only the arming thread is sampled.** A Worker busy for 600 ms added zero
  samples to the main thread's buffer. Off-thread work is invisible here, which
  does not mean it is free.
- **`samplingProfilerStackTraces` is missing from bun-types.** It is declared
  here as returning `unknown`, and `normalizeTraces` is the one checked path to
  a typed value. A result without a `traces` array throws rather than reading as
  an empty profile.

## What a sample contains, and what is missing

`frames` is the **physical** stack, innermost first. Normalization maps JSC's
`0xFFFFFFFF` "no line/column" to `null`, an empty or missing `sourceURL` to
`null`, a missing category to `"native"`, and drops traces with no frames.
`timestamp` is JSC's monotonic clock in seconds, not `Date.now()`.

- **Sync code** is all there: `spin ← checkRun`.
- **An async function resumed after an `await`** is there without its caller:
  `spin ← helper`, no `checkRun`.
- **Module evaluation from `await import()`** has no importer:
  `(module)@file ← evaluate ← moduleEvaluation ← requestImportModule`.
- **Paths are fully resolved.** A `/tmp/…` checkout reports `/private/tmp/…`, so
  a caller stripping a root must also try the root's `realpathSync`. Otherwise
  every frame of a checkout reached through a symlink reads as outside the repo.
- **`line` is the executing line**, not the declaration line, so two samples of
  one function can differ.

## Activities: naming samples that have no frame

Some work leaves no JS frame on a sample — loading and evaluating a module reads
`(anonymous) [Unknown Executable] < processTicksAndRejections`. Code around such
work can say what it is:

```ts
await withThreadActivity({ name: "barrel import", detail: "plugins/a/web/index.ts" },
  () => import(path));
```

Every sample taken between its start and its settle comes out of `drain()` with
`activity` set (the innermost when they nest), else `null`. It records nothing in
a process whose sampler was never claimed.

- **Intervals, not a current value.** A consumer drains after a block ends, when
  the activity has long been cleared, so each is recorded as a `performance.now()`
  interval and matched against the sample's own time. The drain prunes intervals
  that ended before it.
- **Two clocks.** JSC stamps samples in seconds of the system's monotonic time
  (measured: ~476 000 s on a host up for days), `performance.now()` counts from
  process start, and no JS API reads JSC's clock. The offset is bracketed from the
  drains alone — every sample in a batch was taken between the previous drain and
  this one — and the brackets are intersected across batches
  (`createSampleClock`). While the thread is busy across drains they close to about
  one sample period. A batch that contradicts them restarts the estimate.
- **When, not who.** The interval also covers whatever else ran while the marked
  work awaited. A consumer names only frameless samples with it (the check-thread
  watch's `native during <name>` owner), never overrides a frame that names its
  owner.

## `frameKey`

The one spelling of a frame's identity. A frame with a source and a line reads
`name @ path:line`, with the path passed through `shorten` (identity by
default). Any other frame, including a line with no source such as
`asyncModuleEvaluation`, reads `name [category]`. An empty name reads
`(anonymous)`. health-monitor's persisted stall traces carry these keys, so
changing the format changes how existing traces read.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The one owner of bun:jsc's JSC sampling profiler: claimStackSampler(owner) arms it once per process and hands a single reader drain() → normalized stacks (innermost → outermost, JSC's no-line sentinel as null), refusing a second owner because every read empties the shared buffer. Bun-only leaf in core, so a CLI process and a server can both import it; frameKey is the one spelling of a frame's identity.
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `framework/tooling/checks`
    - `plugin-meta/barrel-import`
- Exemptions:
  - Exempts itself from: `boundaries/no-platform-api` — `core/internal/sampler.ts` (debt)
- Core:
  - Exports (types):
    - `StackFrame`
    - `StackSample`
    - `StackSampler`
    - `ThreadActivity`
  - Exports (values):
    - `claimStackSampler`
    - `frameKey`
    - `normalizeTraces`
    - `withThreadActivity`

<!-- AUTOGENERATED:END -->
