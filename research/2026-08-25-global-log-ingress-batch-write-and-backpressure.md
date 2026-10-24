# Log ingress: one write per request, and a way to say "stop"

**Date:** 2026-08-25 · **Category:** global (`infra/file-sink`, `primitives/log-channels`)

## Context

An `event-loop-stall` report showed a backend's main thread frozen for 3461 ms. The hottest
sampled frame was `appendFileSync ← appendLine @ file-sink/core/internal/file-sink.ts:97` —
the server writing browser log lines to disk.

The path: the browser buffers `clientLog(…)` lines and POSTs them in chunks of up to
`MAX_EMIT_LINES = 500`. `handle-emit.ts` loops that array, and each line reaches `appendLine`,
which does a `mkdirSync` **per line** plus a path-based `appendFileSync` (open + write + close)
**per line**. Roughly four blocking syscalls per line, up to ~2000 per POST, on the event loop
with no yield point.

Two honest qualifications, because they set the scope:

- **This is an amplifier, not the whole stall.** The log writes were 15 % of samples; the other
  85 % was spread across unrelated synchronous syscalls (tmux `spawn`, `readFileSync` for the
  server commit, flock `openSync`, Postgres connection setup) — the signature of a host under
  I/O saturation where every blocking call costs real milliseconds. What makes the log loop
  worth fixing anyway is that it is the only place in the repo that fires ~2000 blocking
  syscalls back-to-back in a single macrotask from a single source. Removing it removes the
  largest concurrent-syscall burst in the sampled window; it does not make the backend
  stall-proof.
- **Steady-state volume is low.** The chattiest browser channel (`live-state`) averages ~0.4
  lines/s, and its verbose tracing is behind a dev flag. The realistic 500-line batch is the
  **reconnect drain**: the backend restarts during `./equin build`, the browser buffers
  everything, and the WS-`open` flush (`web/client-log.ts:69-71`) dumps it in 500-line chunks
  exactly as the server is freshly booting.

There is a second gap behind the same report. Traces, slow-ops and reports all route their
durable writes through the duress shed engine; log-channel writes do not. So the one
observability channel whose volume driver is **external** — a browser that keeps POSTing
regardless of host state — is the one that keeps writing at full rate while the box is on fire.

### Why this plan does not use the shed engine

Investigated and deliberately rejected. Four findings, all verified in code:

1. **A direct gate is a dependency cycle.** `duress/server/internal/shed-buffer.ts:10` already
   imports `defineLogSink` from `log-channels/server`. Gating inside `log-channels` would close
   a 2-cycle caught by `./equin check plugin-boundaries`. Working around it means an
   inverted `defineReportSink` seam (the `jobs/server/internal/deadline-seam.ts` pattern), a new
   `duress/plugins/log-shed` sub-plugin, and an `UNSAFE_` replay entry point that bypasses the
   ring and the WS fan-out.
2. **It would mostly drop, not defer.** `bufferMaxEntries = 2000` is shared across all gated
   channels with no per-cascade fairness (drop-newest, and extending it was explicitly rejected
   as scope creep in `research/2026-07-11-global-observability-freeze-blind-spots.md`). One
   chatty tab at 500 lines/POST fills it in about a second, after which everything is
   dropped-and-counted. "Buffered and replayed" would not materialise for the very channel that
   motivated the work.
3. **The crash-loss contract collides with the trigger.** The shed design states "crash-loss is
   user-accepted: first-N durable; buffered tail memory-only." The worst-case trigger here is a
   backend *restart* — which is a crash from the buffer's perspective. Shedding would be most
   likely to activate exactly where it is most likely to discard the browser diagnostics you
   opened `clientLog` to capture.
4. **The exempt set is subtle and two wrong answers are actively harmful.** `health-host` is read
   by the sentinel's own detector (`sentinel/server/internal/worker/sample.ts` →
   `readChannelEntries(worktree, "health-host", 1)`, stale past 3× cadence) — gating it blinds
   the mechanism deciding whether to *clear* the episode it is gating. Gating `worktree-removal`
   turns a missing `in-app` line into a false `worktree-removed-externally` report — a wrong
   answer, not a missing one.

The remaining argument for a gate was "it covers server-side channels too". Those channels write
one line per logical event, the highest-cadence being `health` / `health-host` at one line per
10 s. There is no volume there to shed.

**So: batch the write (unconditional, every request), and give the endpoint a way to tell an
external client to stop (conditional, during duress).** Backpressure removes the *whole* request
— parse, zod validation of up to 500 lines, ring pushes, WS fan-out — which a sink-level gate
never touches.

---

## Part 1 — The array is the unit at every layer

Today's per-line entry points are what let a loop exist. Remove them, and `handleEmit` has
nothing to loop over.

One correction to an earlier reading: `logsDir()` is **not** re-resolved per line —
`getOrCreateChannel` stores the factory and invokes it once, on the channel's first publish. The
per-line cost in `client-ingress.ts` is a closure allocation and a `Map.get`. The four syscalls
in `appendLine` are the entire prize. After this change a 500-line POST goes from ~2000 blocking
syscalls to **3**.

### 1a. `FileSink.appendAll(lines: readonly string[]): void`

`plugins/infra/plugins/file-sink/core/internal/types.ts` — add to the `FileSink` interface. The
only construction site is `makeSink`, so nothing external implements it.

`plugins/infra/plugins/file-sink/core/internal/file-sink.ts` — replace `appendLine` with a single
`appendLines(path, lines, maxBytes, keep)`; `append(line)` becomes `appendLines(path, [line], …)`
and `appendAll(lines)` becomes `appendLines(path, lines, …)`. **One implementation, one size
gate** — two copies is exactly how the "a line is never split across a rotation" invariant would
drift.

The gate runs **per rotation group**, not per batch and not per line. Per batch is too coarse:
`EmitLogsBodySchema` puts no length cap on an individual line, so one batch can exceed `maxBytes`
many times over and `bound` would become a lie by an unbounded margin. The algorithm is
byte-for-byte equivalent to `for (const l of lines) append(l)`, with the writes coalesced:

```
appendLines(path, lines, maxBytes, keep):
  if lines.length === 0: return              // no write, no mkdir, no file created
  size = fileBytes.get(path) ?? seedFromStatSync(path)     // ENOENT -> 0
  group = []; groupBytes = 0

  flush():                                    // one appendFileSync per rotation group
    if group empty: return
    write(path, group.join("\n") + "\n")
    size += groupBytes; fileBytes.set(path, size)
    group = []; groupBytes = 0

  for line in lines:
    b = Buffer.byteLength(line, "utf8") + 1
    if size + groupBytes + b > maxBytes AND size + groupBytes > 0:
      flush(); rotateFile(path, keep); size = 0; fileBytes.set(path, 0)
    group.push(line); groupBytes += b
  flush()
```

Properties to state in the code comment and in `file-sink/CLAUDE.md`:

- Every `appendFileSync` payload is a whole number of `\n`-terminated lines, and a rotation only
  happens *between* two of them. `readTail({includeRotated:true})`'s stitching and
  `log-channels/server/internal/persist.ts`'s envelope reader are untouched — both only ever
  assumed "one JSON object per newline, in order, tolerating a torn final line".
- A batch larger than `maxBytes` performs ⌈bytes/`maxBytes`⌉ rotations inside the one call, and
  `keep` stays a hard cap. Identical to looping `append` today.
- `fileBytes` is updated immediately after each successful write and zeroed immediately after
  each rotation, so a mid-batch ENOSPC leaves the counter describing exactly what is on disk.
- **One deliberate behaviour change**, which must be in the commit message and pinned by a test:
  the `size + groupBytes > 0` guard means a single line larger than `maxBytes` written into an
  empty or absent live file is written whole *without* first burning a rotation slot on a no-op
  rename chain. Reachable only in the degenerate case; strictly better.

### 1b. Stop calling `mkdirSync` on every append

Do **not** memoize with a `Set` of ensured directories — that caches a belief about the world
that worktree teardown can falsify. Invert it instead:

```
write(path, payload):
  try: appendFileSync(path, payload)
  catch err:
    if err.code !== "ENOENT": throw
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, payload)          // a second ENOENT throws — loud
```

For a file opened with flag `"a"`, `ENOENT` means exactly one thing: a missing path component. So
this is behaviourally identical to today's unconditional `mkdirSync`, including the self-healing
if a live backend's logs dir is deleted — the recreate happens when it is needed rather than
being cached. Zero `mkdir` syscalls in steady state, no unbounded module state. This benefits all
~25 `defineLogSink` channels and all four CLI sinks, not just the batched path.

Doc obligation: `checks/core/progress-log.ts:107` says "the only errors it swallows are `ENOENT`
on the rotation renames" — add a clause for the directory-recreate retry. Check whether
`cli/op-runtime/cli/build-progress.ts:99` carries the same claim.

### 1c. `LogChannel.publishAll`

`plugins/primitives/plugins/log-channels/server/internal/registry.ts` — `publishAll(items:
readonly PublishLine[])` where `PublishLine = { line: string; stream?: LogStream; timestamp?:
number }`. It is the single implementation; `publish(line, stream, timestamp)` delegates with a
one-element array (same anti-drift argument as `append`).

Three things inside it:

- **Trim the ring once, not per line.** Push all entries with a `for` loop (**not**
  `push(...built)` — `publishAll` is public and a large array would blow the stack), then
  `const overflow = entries.length - MAX_HISTORY; if (overflow > 0) entries.splice(0, overflow)`.
  That replaces 500 `shift()`s — ~40 MB of memmove per POST against a full 10 k ring — with one
  ~76 KB `splice`. `entries` stays a plain oldest-first array, so `subscribe()` is untouched.
  (An index-based circular buffer is O(1) rather than O(1)-amortised, but the difference is one
  76 KB memmove per POST and the price is rewriting `subscribe`'s history read — the one function
  feeding the viewer's seq-dedup. Not worth it.)
- **One `sink.appendAll(...)`** for the whole batch.
- **Order: ring → sink → listeners.** That makes "durable before broadcast" true per batch,
  strictly stronger than today's per-line interleave where the property holds nowhere. Per-line
  WS delivery is preserved exactly: one `fn(entry)` per line, in order.

### 1d. `emitClientLogs(body: EmitLogsBody)` and a one-expression handler

`client-ingress.ts` — replace `emitClientLog` (delete the singular form; do not keep both). It
takes the whole validated body, so the zod `.min(1).max(500)` that bounds the array is the same
type the ingress consumes. It calls `ensureFamilyBound()` once, resolves the channel once, and
maps `{line, stream, t}` → `{line, stream, timestamp}` once — the layer boundary where the wire's
`t` becomes the registry's `timestamp`.

`handle-emit.ts` becomes:

```ts
export const handleEmit = implement(emitLogs, ({ body }) => { emitClientLogs(body); });
```

### Where this lands on the fix ladder — honestly

You cannot make "call `append` in a loop" a type error, so this is **not** rung 1 or 2 in
general. What it does reach:

- **Rung 2 for the ingress path specifically.** After the change there is no per-line entry point
  between the HTTP handler and the sink. Reintroducing a loop requires first re-inventing a
  singular function that no longer exists — a visible, reviewable act, not an oversight. Since
  the browser ingress is the repo's only multi-line-per-turn writer, that closes the class as it
  exists today.
- **Rung 5 for the general case**, and for one caveat: a batched write loses the `O_APPEND`
  whole-line atomicity that host-global files rely on for cross-process interleaving
  (`progress-log.ts:107`). No current caller needs it — the browser channels are written by
  exactly one process — but document it in `appendAll`'s doc comment and in
  `file-sink/CLAUDE.md`: *`appendAll` is for a single-writer file; a host-global file appended by
  several processes must keep using `append`, one line per call.* Chunking every batch under 4 KB
  to make the property universal would turn 3 syscalls per POST back into ~39, for zero call
  sites. If a multi-process batched writer ever appears, the fix then is a `FileSinkSpec` flag
  that makes `appendAll` throw.

### Explicitly rejected

- **A lint rule banning `.append(` in a loop.** The invariant is not "never loop" — a migration
  runner publishing one line per step is correct. The real invariant ("don't loop synchronously
  over an unbounded client-supplied array") is not syntactically visible, so the rule would ban
  legitimate code and get allowlisted into meaninglessness.
- **Internal coalescing on a `setImmediate` boundary.** The only design that would also fix a
  caller who does loop — rejected on merit: it converts a synchronous durable write into a
  deferred one. `log-channels` promises the file survives the restart `./equin build`
  performs; the four CLI sinks live in processes that exit or are hard-killed between publish and
  flush; and `retention.getGrowthBounds()` merges `bound` as *behaviour*, which stops being true
  if rotation happens a tick after the write.
- **Holding an open fd per sink.** Three independent killers: `op-log` / `build-progress` /
  `check-progress` are host-global files where another process's rotation would leave this
  process writing into a renamed inode (silent loss, in exactly the incident conditions those
  files exist for); `openDynamicSink` is an unbounded family, so per-sink fds mean an unbounded fd
  set on a host that already has a launchd FD-leak monitor; and after batching the prize is ~2
  syscalls per 500 lines.
- **A server-side yield between chunks.** There are no chunks left — one POST is one
  `appendFileSync`. The client already awaits each `fetchEndpoint` before splicing the next 500
  (`client-log.ts:45-48`), so a 10 000-line drain is already 20 sequential POSTs with the loop
  free in between. (`primitives/perfs/plugins/scheduler` is web-only regardless.)
- **Lowering `MAX_EMIT_LINES`.** Counterproductive after batching: total lines are unchanged, so
  a smaller cap just multiplies per-POST request overhead — which batching does *not* remove.

---

## Part 2 — Backpressure: let the endpoint say "stop"

Batching makes each request cheap. Backpressure makes the request not happen at all while the
host is in trouble. This is the answer to "an external source keeps writing while the box is on
fire", and it removes what a sink-level gate cannot: the HTTP parse, the zod validation of up to
500 lines, the ring pushes, and the WS fan-out.

### 2a. Server — 429 while the duress latch is set

`plugins/primitives/plugins/log-channels/server/internal/handle-emit.ts` — one
`isUnderDuress()` call **per request** (not per line) before touching the registry; if tripped,
throw `HttpError(429, …)` and never open a channel.

**`Retry-After` is not sent — this is a known gap, not an oversight.** `HttpError` is
`constructor(status: number, message?: string)` with no header seam, and `implement()`'s catch
returns `new Response(err.message, {status})`; `EndpointError` on the client carries only `status`
and `body`. So a header could neither be set nor read. The client keys its backoff off
`err.status === 429` instead, which is functionally equivalent for our own client. What is lost is
the server *choosing* the delay, and the header for any non-`fetchEndpoint` caller. Closing it
means optional `headers` on `HttpError` threaded through `implement()`, plus headers on
`EndpointError` — both shared by every route in the repo, so it belongs in its own change.

Import from `@plugins/infra/plugins/duress/plugins/latch/server`. **Verified acyclic**: the latch
sub-plugin's entire import closure is `node:fs`, `node:path`, `../../data-dirs` and
`server-core/core` — it does not reach `log-channels`. This is the cheap edge that the full shed
gate is not.

`isUnderDuress()` is genuinely cheap: an in-process memo with `MEMO_TTL_MS = 2000`, so at most
one `statSync` per process per 2 s.

**Use 429, not 503 — this is load-bearing.**
`reports/plugins/endpoint-errors/web/components/endpoint-error-reporter.tsx:66` files a report for
`status >= 500`. A 503 would make every rejected POST file a client-side "server error" report
*during duress*, straight into the reports funnel — a self-inflicted report storm triggered by the
storm-suppression mechanism. 429 is below that threshold.

### 2b. Client — bound the buffer, and retry on a timer

`plugins/primitives/plugins/log-channels/web/client-log.ts`. The existing failure path already
does the right thing (`lines.unshift(...drained); break;` — order-preserving re-queue, retried on
the next debounce or WS `open`), so a 429 needs no new handling. Two real gaps to close:

- **The buffer is unbounded today.** `clientLog` pushes with no cap, so a long episode plus a
  chatty tab grows browser memory without limit — and single-instance-per-user means that is the
  same host. Add a per-channel cap with **drop-oldest** (deliberately the opposite of the shed
  buffer's drop-newest: the browser has no first-N onset guarantee, and its newest lines describe
  the problem the user is looking at right now). Emit a `[clientLog] dropped N lines under
  backpressure` line so the loss is visible rather than silent.
- **Retry is event-driven only.** If logging goes quiet, buffered lines sit until a WS reconnect.
  Add a one-shot `setTimeout` on the failure edge, with a longer delay for a 429 (the box is on
  fire) than for a plain restart (resolves in seconds). This is a failure-edge timer, not a
  poll loop.

### 2c. One line of free observability

Add `slowThresholdMs` (a few hundred ms) to the `emitLogs` endpoint in `core/endpoints.ts`.
`implement()` already publishes it to the slow-ops funnel, so any future regression on this path
names the route in slow-ops instead of surfacing as an anonymous stall in a profile.

---

## Files

**Part 1**
- `plugins/infra/plugins/file-sink/core/internal/types.ts` — `appendAll` on `FileSink`
- `plugins/infra/plugins/file-sink/core/internal/file-sink.ts` — `appendLines`, ENOENT-retry writer
- `plugins/primitives/plugins/log-channels/server/internal/registry.ts` — `PublishLine`, `publishAll`, batched `splice`, ring→sink→listeners order
- `plugins/primitives/plugins/log-channels/server/internal/client-ingress.ts` — `emitClientLogs(body)`
- `plugins/primitives/plugins/log-channels/server/internal/handle-emit.ts` — one expression

**Part 2**
- `plugins/primitives/plugins/log-channels/server/internal/handle-emit.ts` — 429 gate
- `plugins/primitives/plugins/log-channels/web/client-log.ts` — buffer cap, retry timer
- `plugins/primitives/plugins/log-channels/core/endpoints.ts` — `slowThresholdMs`

**Docs** (`plugins-doc-in-sync` fails on drift; run `./equin build` before pushing)
- `plugins/infra/plugins/file-sink/CLAUDE.md` — `appendAll`; the per-rotation-group gate; single-writer-only caveat; extend the `includeRotated` safety sentence to name the batch case
- `plugins/primitives/plugins/log-channels/CLAUDE.md` — `publishAll`; one POST is one file write; the duress 429 and what the client does with it
- `plugins/framework/plugins/tooling/plugins/checks/core/progress-log.ts:107` — amend the swallowed-errors clause

**Verified non-issues**: `no-adhoc-file-sink` skips the `file-sink/` directory in-rule, so no lint
work. `infra/retention` consumes only `bound`, unchanged. `paging-probe/server/internal/probe-host.ts`
holds a `LogChannel` and calls `publish` — an added method does not affect it.

## Sequencing

Each step independently green. Part 1 lands first and alone — it is the urgent half and touches a
hot path with ~25 cross-plugin importers, so keep its diff reviewable.

1. `types.ts` — add `appendAll`
2. `file-sink.ts` — `appendLines` + ENOENT-retry; file-sink tests
3. `registry.ts` — `publishAll`, ring trim, ordering; registry tests
4. `client-ingress.ts` → `emitClientLogs`; `handle-emit.ts` → one expression
5. `endpoints.ts` — `slowThresholdMs`
6. *(Part 2, separate)* 429 gate; client buffer cap + retry timer

## Tests

Run with `./equin test plugins/infra/plugins/file-sink` and
`./equin test plugins/primitives/plugins/log-channels`.

**`file-sink/core/internal/file-sink.test.ts`** — same hermetic conventions already there
(`mkdtempSync` per test, unique sink id since the registry is process-global). Do *not* assert
syscall counts here; `appendFileSync` is a bound ESM import and mocking it is more fragile than no
test. Assert observable invariants:

1. 5-line batch under the cap → in order, one file, no `.1`
2. `appendAll([])` under a non-existent nested dir → creates neither file nor directory
3. Cap crossed mid-batch → concatenating `.1` then live equals the input line-for-line, **every
   line whole** (the "never split a rotation" test)
4. Boundary arithmetic: exactly `maxBytes` (no rotation) and `maxBytes + 1` (rotation) — pins `>` vs `>=`
5. Batch exceeding `maxBytes × (keep + 1)` → `keep` still a hard cap, live file holds the tail
6. A single line larger than `maxBytes` inside a batch → written whole, preceding lines flushed to `.1` first
7. A single oversized line into an empty file → no rotation slot burned (pins the deliberate change)
8. **Equivalence** — two sinks, identical bounds; one fed `for (l of lines) append(l)`, the other
   one `appendAll(lines)`, over a set crossing two rotations: live file and every rotation
   byte-identical. This is what catches drift if the two paths are ever re-split.
9. Directory-recreate retry — append, `rmSync` the temp dir, append again, assert the line lands

**`file-sink/core/internal/read.test.ts`** — one addition: an `appendAll` batch crossing a
rotation, read back with `readTail({includeRotated:true})`, asserted oldest-first, complete, no
torn line. The direct guard on the documented stitching invariant.

**New: `log-channels/server/internal/registry.test.ts`** — the first test for this file. Pure: no
fs, no env, no boot graph, because the sink is injected. Use a stub satisfying `FileSink`
(type-only import) with counters; unique channel ids per test.

1. **One write per batch** — `publishAll` of 500 items: `makeSink` called exactly once,
   `appendAll` called exactly once with 500 lines, `append` never. The real regression guard.
2. Per-line WS delivery preserved — 500 individual listener callbacks, in order, contiguous ascending `seq`
3. Ring trim — publish past `MAX_HISTORY` in batches; history is exactly `MAX_HISTORY` and holds
   the **newest** entries (catches a `splice` off-by-one)
4. `publish` delegates — one entry, one `appendAll` of length 1
5. Ephemeral `Log.channel` — publishes touch no sink

**Part 2: `handle-emit.test.ts`** — under duress: status **429** (assert the literal number; the
5xx-reporter interaction is the reason), no channel created, no `append`.
Not under duress: normal path.

**Must stay green unchanged**: `log-channels/server/internal/persist.test.ts`,
`read-channel-json.test.ts`, `duress/server/internal/shed-buffer.test.ts`.

## Verification end-to-end

1. `./equin build` (background — it is well over the foreground cap), then confirm
   `~/.singularity/worktrees/<wt>/build-status.json` reads `status: ok`.
2. `./equin check plugin-boundaries` — the `log-channels → latch/server` edge is the one new
   cross-plugin import; this proves it stays acyclic.
3. Open `http://<worktree>.localhost:9000`, then Debug → Logs and pick a browser channel. Confirm
   lines still stream live over the WS (per-line delivery preserved) and that
   `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl` still parses one JSON object per line:
   `tail -5 …/<channel>.jsonl | jq .`
4. **The batch path**, which the debounce hides in normal use: in the browser console, drive a
   burst through the buffer — `for (let i = 0; i < 1500; i++) clientLog("batch-probe", "line " + i)`
   — then confirm all 1500 landed in order:
   `wc -l ~/.singularity/worktrees/<wt>/logs/batch-probe.jsonl` and
   `jq -r .line …/batch-probe.jsonl | head -3`.
5. **Rotation under batching**, the highest-risk change: temporarily declare a sink with a small
   `maxBytes` in a scratch script, `appendAll` a batch that crosses the boundary, and confirm
   `cat file.1 file` reads back as unbroken whole lines. (Test 3 above covers this; do it once by
   hand too, since it is the invariant every reader depends on.)
6. **Backpressure** (Part 2): set the duress latch by hand under
   `~/.singularity/state/…/duress` (see `duress/plugins/latch/server/internal/latch.ts` for the
   file shape and the 60 s freshness lease), then confirm `POST /api/logs/emit` returns 429 with
   (with NO `Retry-After` — see above), that the browser re-queues rather than dropping, and that clearing the latch
   drains the backlog. Confirm **no** report appears in Debug → Reports from the rejection — that
   is the 429-not-503 property.
7. Re-check the stall surface afterwards: Debug → Reports should stop showing
   `event-loop-stall` reports whose `hotFrame` names `file-sink.ts`. Other stall causes will
   remain; that is expected and is the point of the "amplifier, not the whole stall" framing.

## Follow-ups (tracked, not in this change)

- **`health.jsonl` is size-managed twice.** `health-monitor/server/internal/process-sampler.ts:81-93`
  `rotateIfNeeded()` runs on every 10 s tick and, past 5 MB, does a full `readFileSync` + split +
  slice + join + `writeFileSync` — on the same file `defineLogSink({id:"health"})` already backs
  with file-sink's 128 MB × 3 rotation. The two never coordinate, so file-sink's `fileBytes`
  counter drifts and the declared `bound` is not the operative one — "`append()` IS the rotation"
  is false for this file, which is what `retention.getGrowthBounds()` relies on. Fix: forward
  `maxBytes` / `keep` through `defineLogSink` (it hardcodes neither today), delete `rotateIfNeeded`
  and `MAX_FILE_BYTES`, and pick `keep` deliberately (file-sink's default 3 triples storage versus
  today's single 5 MB cap). Separate PR: different plugin, its own small API change.
- **The WS fan-out is the next per-line cost on this path.** With a log viewer open,
  `ws-handler.ts` does one `ws.send(JSON.stringify(msg))` per line, so 500 sends run synchronously
  per POST. After Part 1 that is the dominant per-line cost. The fix is to batch the WS protocol,
  not to yield — and it is cheap, because `live-log-channel.tsx:99-106` already handles a
  multi-entry `history` message. Measure before building it.
- **`EmitLogsBodySchema` puts no length cap on an individual line** (`line: z.string()`), so one
  batch can dwarf `maxBytes`. `appendLines` handles it correctly, but a per-line cap is the right
  boundary guard.
- **`timeline/server/internal/downsample.ts`** documents "JSONL append order is already
  chronological" and its `points.length <= maxPoints` fast path returns input order unsorted. That
  holds today and this change does not break it — but it is an undefended assumption worth a
  one-line sort on the fast path.
