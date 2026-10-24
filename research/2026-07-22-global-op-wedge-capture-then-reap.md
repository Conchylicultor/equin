# Op-wedge watchdog: JS-level self-interrogation + capture-then-reap

## Context

The CLI op wedge (a `./equin {build,check,push}` burning ~1 core forever,
gridlocking the fleet behind cpu-slots and the push mutex) was captured live on
2026-07-22 and its mechanism named to the JS boundary: a **native microtask
storm** drained forever by `processTicksAndRejections` at the `drainMicrotasks()`
call site (bc#365 on bun 1.3.13). See
[`research/2026-07-22-global-cli-op-wedge-named-function.md`](./2026-07-22-global-cli-op-wedge-named-function.md).
The bug is upstream bun (oven-sh/bun#27766, open, unfixed through 1.4-canary);
the one remaining unknown is the **producer** — which native subsystem refills
the queue. That capture was manual and took 40 interactive minutes; wedges
mostly fire unattended and currently burn for hours teaching nothing.

This change makes every future wedge (a) interrogate itself at the JS level
automatically, using the exact protocol proven in that session, and (b) get
**reaped after forensics are banked**, so one wedge no longer gridlocks the
fleet for hours. Both were confirmed decisions: **reap by default**, and **reap
even when the JS interrogation partially fails** (fleet health first; the report
is flagged PARTIAL).

Reap safety is already guaranteed by existing self-healing: the push mutex is a
kernel flock on `push.lock` ("held only by the CLI push process, auto-released
on death" — `worktree-op.ts:284`), host-semaphore slots are flock fds that
auto-release when the process dies (`host-semaphore/scripts/flock-block.ts:17`),
and op markers are reaped by every reader when the pid is dead ("so a SIGKILLed
build/push self-heals on the next read" — `worktree-op.ts` marker parse). A
push-nested check being reaped surfaces as a check failure to its parent push,
which exits through its normal failure path (observed live 2026-07-22).

## Changes

### 1. Surface `inspect` on `WorktreeOpInfo`

`plugins/infra/plugins/worktree/server/internal/worktree-op.ts` writes the
inspector ws URL into the marker (`inspect` field, line ~104) but the reader
drops it. Add:

- `inspect?: unknown` to `MarkerJson`
- `inspect: string | null` to `WorktreeOpInfo` (comment mirroring the existing
  `pid` rationale: the watchdog needs it to point the inspector probe, and
  re-parsing marker JSON by hand would fork the format away from its owner)
- populate in `markerInfoFromParsed`: `typeof parsed.inspect === "string" ? parsed.inspect : null`

### 2. JS interrogation script (the proven protocol)

New `plugins/debug/plugins/op-wedge-watchdog/scripts/js-interrogate.ts` —
sibling of the vendored `inspector-client.ts`. One invocation runs the full
safe protocol against a wedged bun over its inspector ws and prints ONE JSON
document to stdout:

1. Connect (plain WebSocket JSON-RPC, same as `inspector-client.ts` — extract
   the small RPC core into `scripts/inspector-rpc.ts` shared by both scripts
   rather than duplicating it).
2. `Runtime.evaluate`: stash `bun:jsc` via dynamic import into a global
   (`require` is not available in eval scope — verified).
3. `startSamplingProfiler()`; wait `--seconds` (default 60) accumulating.
4. `samplingProfilerStackTraces()` → summarize: per-stack counts of
   `name|category|location` chains (the wedge signature is
   `?|Unknown Executable < processTicksAndRejections|FTL|bc#365`).
5. `heapStats()` twice (start + end) → allocation delta.
6. `getProtectedObjects()` **histogram only** (constructor-name counts).
   **HARD RULE, encoded as a comment and honored by the code: never
   `jscDescribe`/deep-introspect protected objects — that is the probe that
   SIGTRAP-crashed the 2026-07-22 specimen.**
7. Per-step errors collected into a `failures` array (same shape as
   `capture.ts`), never thrown; partial output is still printed.

The script is self-terminating with an internal deadline; the server side also
bounds it (below). Output JSON shape:

```ts
{
  wsUrl: string,
  traceCount: number,
  topStacks: Array<{ stack: string; count: number }>,   // top 10
  heap: { t0: {...}, t1: {...}, wallMs: number } | null,
  protectedHistogram: Record<string, number> | null,
  failures: Array<{ step: string; error: string }>,
}
```

### 3. Probe + reap modules in the watchdog server

`plugins/debug/plugins/op-wedge-watchdog/server/internal/probe.ts`:

- `export async function probeWedgeJs(info): Promise<JsProbeResult>` — spawns
  `bun <plugin>/scripts/js-interrogate.ts ws://<inspect> --seconds <cfg>` via
  the existing bounded-spawn pattern. Export `runBounded` from `capture.ts`
  (it is exactly the needed primitive: drain both pipes, await exit, SIGKILL on
  deadline) instead of duplicating it. Deadline = probe seconds + 30s.
- Also takes a **second lsof** (`runBounded([lsofBin, "-p", pid])`) after the
  probe window, so the dump carries lsof-at-trip (from `captureOpWedge`) and
  lsof-after-60s — the "does the socket vanish while the burn continues?"
  question from the research doc.
- Appends the raw probe JSON + second lsof to the same `op-wedge-capture` file
  sink (clamped with the existing `MAX_SECTION_BYTES` pattern) and returns the
  compact summary for the payload. Skipped entirely (with an explicit
  `armed: false` marker, not silence) when the marker has no `inspect`.

`plugins/debug/plugins/op-wedge-watchdog/server/internal/reap.ts`:

- `export async function reapWedge(pid): Promise<ReapResult>` — verify pid
  still alive → `process.kill(pid, "SIGTERM")` → poll up to 5s →
  if alive `SIGKILL` → poll up to 2s → outcome one of
  `"exited-sigterm" | "exited-sigkill" | "survived" | "already-dead"`.
  (SIGTERM first: the CLI installs graceful handlers — `build.ts:887` maps
  SIGTERM→143 and runs cleanup; upstream #27766 reports SIGTERM ignored by the
  spin, hence the escalation.) Kills ONLY the wedged pid, never descendants —
  observed culprits have none, and the capture's child tree records any that
  exist for the report.
- `capture.ts` itself stays byte-for-byte read-only (its "we never signal"
  contract holds); the reap is a separate module invoked by the monitor, which
  is exactly the separation the current comment promises ("reaping is a
  separate decision") — the decision is now policy.

### 4. Monitor job orchestration

`monitor-job.ts` per tripped wedge (after the existing dedupe mark):

1. `captureOpWedge(...)` (unchanged, read-only, ~15s)
2. `cfg.jsProbe && info.inspect` → `probeWedgeJs(...)` (~90s bounded)
3. `cfg.reap` → `reapWedge(info.pid)` — runs regardless of capture/probe
   partiality (confirmed decision)
4. ONE `recordReport` carrying capture + probe summary + reap outcome; the
   one-line message gains ` — hot: <top frame>` (when probed) and
   ` — reaped (<outcome>)` / ` — NOT reaped (disabled)`.

### 5. Config additions (`core/config.ts`)

- `jsProbe: boolField({ default: true })` — run the inspector interrogation on
  armed wedges.
- `jsProbeSeconds: intField({ default: 60, min: 10 })` — profiler accumulation
  window.
- `reap: boolField({ default: true })` — kill the wedged process after
  forensics are banked. Description states the safety basis (flocks + marker
  reap self-heal) and that turning it off restores stakeout behavior.

### 6. Payload schema (`core/kinds.ts`) — additive, optional fields

```ts
jsProbe: z.object({
  armed: z.boolean(),                 // marker carried an inspector URL
  wsUrl: z.string().nullable(),
  traceCount: z.number().nullable(),
  topStacks: z.array(z.object({ stack: z.string(), count: z.number() })),
  heapDelta: z.object({ wallMs: z.number(), heapBytes: z.number(), objects: z.number() }).nullable(),
  failures: z.array(z.object({ step: z.string(), error: z.string() })),
}).optional(),
reap: z.object({
  outcome: z.enum(["exited-sigterm", "exited-sigkill", "survived", "already-dead", "disabled"]),
}).optional(),
```

### 7. Renderers + docs

- `op-wedge-kind.ts` `renderDescription`: new "JS interrogation" section (top
  stacks table, explicit callout when the dominant stack matches the known
  drain-site signature `processTicksAndRejections … bc#365` → link the
  named-function research doc), and a "Reap" section replacing the two "was
  deliberately NOT killed" paragraphs (which become conditional on
  `reap.outcome === "disabled"`/absent).
- `web/components/op-wedge-summary.tsx` one-liner: add hot-frame name (when
  probed) and a `reaped` chip.
- `server/index.ts` description + `monitor-job.ts` comments + plugin
  `CLAUDE.md`: replace the "Never kills the specimen" promise with the
  capture-then-reap policy and its rationale; document the jscDescribe
  prohibition in the CLAUDE.md capture section.

## Files touched

- `plugins/infra/plugins/worktree/server/internal/worktree-op.ts` (+ its test)
- `plugins/debug/plugins/op-wedge-watchdog/scripts/inspector-rpc.ts` (new, extracted)
- `plugins/debug/plugins/op-wedge-watchdog/scripts/inspector-client.ts` (import rpc core)
- `plugins/debug/plugins/op-wedge-watchdog/scripts/js-interrogate.ts` (new)
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/capture.ts` (export `runBounded` only)
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/probe.ts` (new)
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/reap.ts` (new)
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/monitor-job.ts`
- `plugins/debug/plugins/op-wedge-watchdog/core/{config,kinds}.ts`
- `plugins/debug/plugins/op-wedge-watchdog/server/internal/op-wedge-kind.ts`
- `plugins/debug/plugins/op-wedge-watchdog/web/components/op-wedge-summary.tsx`
- `plugins/debug/plugins/op-wedge-watchdog/CLAUDE.md`, `server/index.ts`

## Tests (bun:test, co-located — precedent: `capture.test.ts`)

- `reap.test.ts`: (a) dummy bun child that exits on SIGTERM → `exited-sigterm`;
  (b) dummy that traps+ignores SIGTERM in a yielding loop → `exited-sigkill`;
  (c) already-dead pid → `already-dead`.
- `probe.test.ts`: spawn a dummy `bun --inspect=localhost:<port>/<tok>` running
  a busy *yielding* JS loop (the validated control shape), run
  `js-interrogate.ts` against it with `--seconds 3`, assert `traceCount > 0`
  and named frames present; and against a dead ws URL assert a `failures`
  entry, not a throw.

## Verification (end-to-end)

1. `./equin build` to deploy.
2. Synthetic wedge: launch a long-running armed dummy op — write a fake marker
   (`~/.singularity/worktrees/<wt>/ops/check.json` with a live pid of a
   `bun --inspect` dummy spinning a yielding loop, `startedAt` older than
   budget, `phase: "running"`) — then trigger the monitor job (Debug → Queue,
   or wait a tick) and confirm: report filed with jsProbe topStacks naming the
   dummy's hot function, dump contains probe JSON + both lsofs, dummy pid is
   gone, reap outcome recorded.
3. Confirm marker was reaped by the next `resolveActiveWorktreeOps` pass and no
   stale flock remains (`./equin push` from another worktree proceeds).
4. Real-world: next field wedge (several/day currently) should appear in
   Debug → Reports with a named hot stack and `reaped` — and the push mutex
   should free within ~2 min of the budget tripping instead of hours.

## Explicitly out of scope

- Fixing the producer (gated on the evidence this change collects).
- cpu-slot/push-mutex lease-reclaim (separate structural task from the verdict
  doc; this change removes most of its urgency).
- Watchdog re-trip on idle→spinning transition (existing listed follow-up).
- Commenting on oven-sh/bun#27766 (user-driven, uses this change's output).
