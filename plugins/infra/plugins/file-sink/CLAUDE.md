# file-sink

The bounded-append / rotation primitive: one file sink that **cannot grow without
bound** because `append()` IS the rotation. Extracted from
`log-channels/server/internal/persist.ts` (the 128 MB × 3-rotation size-gate) into
a standalone leaf so it has a single owner and can be reused.

**Node-only — `node:fs` + `node:path`, no `db`, no `jobs`.** A short-lived CLI
process (no server, no DB) can import it and still get a size-bounded file. The
caller supplies an **absolute** `path`; the line encoding (a JSON envelope, plain
text, …) is the caller's concern — `append(line)` writes `line + "\n"` verbatim.

```ts
import { defineFileSink } from "@plugins/infra/plugins/file-sink/core";

const buildLog = defineFileSink({
  id: "build-log",
  description: "`./equin build` step timings, read by the Profiling Gantt",
  path: "/…/build-log.jsonl", // absolute, caller-owned
  // maxBytes? default 128 MB   keep? default 3
});
buildLog.append(JSON.stringify(record)); // rotates at the cap, atomically
buildLog.appendAll(records.map((r) => JSON.stringify(r))); // …or a whole batch, as ONE write
```

## A sink is evidence, not a signal

A sink never declares who reads it. Detecting a failure and alerting on it
belongs to the code that owns the operation: it files a `ReportKind` (e.g. the
boot watchdog files `boot-wedge` for a boot that never became ready). A report
may point at a sink as its evidence; a sink never points at a report. (A
required `consumer` classification on every sink, validated by a
`durable-signals-accounted` check, was tried and removed — it labelled files
without making any failure detectable. See
`research/2026-10-15-global-remove-sink-consumer-classification.md`.)

## Bound is true by construction

A `FileSink`'s `bound` (`{ kind: "rotate", maxBytes, keep }`) is not a *claim* to be
checked — it is the sink's own behavior. `append()` gates on an **in-memory
per-file byte counter** (not a `statSync` per line — that would double the syscall
cost on the hot append path) and, when the next line would cross `maxBytes`,
rotates `path` → `path.1`, `path.1` → `path.2`, …, drops `path.keep`, then writes
the line into a fresh live file. So a sink that *exists* is a sink whose file is
bounded; there is no "declared but unbounded" state. `appendAll` shares that one
implementation and one gate — see below — so a batch is bounded identically. This
is why every registered sink's `bound` is a real growth bound without verifying
anything — the file half beside retention's table half (see
`../retention/CLAUDE.md`).

Rotated files are `path.N` — the suffix is appended **after** the full path (a
`foo.jsonl` live file rotates to `foo.jsonl.1`), so a `endsWith(".jsonl")` listing
filter naturally excludes the rotations.

## API

- **`sink.append(line)` / `sink.appendAll(lines)`** — asynchronous: one line, or
  a whole batch, queued on the live path's writer (a keyed coalescer, one per
  path in the process — `openDynamicSink`'s fresh sink objects for one file
  share it). At most one write runs per path; lines appended meanwhile fold into
  the next write, in call order, so appends never interleave or reorder and two
  writes can never both decide to rotate. The promise resolves once the lines
  are on disk and rejects when the write fails — `void` it and that is an
  unhandled rejection, loud. **The only form a backend uses**
  (`blocking-fs/no-sync-fs`): a synchronous append froze main's event loop for
  3.2 s on a busy disk (a health-monitor tick's log line, 2026-11-08).
  `settleFileSinkWrites()` resolves once everything queued so far has landed —
  `log-channels#machine` awaits it in `onShutdown`. A line stays in the queue
  until the write carrying it is issued, and `flushQueuedAppendsSync()` writes
  every such line synchronously, in order: the server half arms it as the
  `exit` listener of every backend (a `process.exit`, a fatal report, an
  uncaught exception), and a CLI root calls it from its own (fs-wait's). Only a
  write already issued, or a SIGKILL, can lose a line.
- **`sink.appendSync(line)` / `sink.appendAllSync(lines)`** — the same append,
  blocking until it is on disk: for a process that may block — a CLI op's event
  that must survive the process dying on its next statement, an `exit` handler.
  It bypasses the queue, so a process writes a sink one way, except an `exit`
  handler writing its last line.
- Both writers walk ONE plan (`planAppend`: the size gate turns lines into
  `write` / `rotate` steps), so `appendAll(lines)` is byte-for-byte
  `for (const l of lines) append(l)`, sync or async. Keep it that way: two gates
  is how "a line is never split across a rotation" would drift apart.
  - The gate runs **per rotation group**, not per batch (a batch has no length or
    byte cap — the browser supplies it) and not per line. Lines accumulate until
    the next one would cross `maxBytes`; that group goes out as one write, *then*
    the file rotates. So a batch bigger than `maxBytes` rotates several times
    inside the one call and `keep` stays a hard cap.
  - **`appendAllSync` is for SINGLE-WRITER files only.** One large batched write
    is not covered by the `O_APPEND` whole-line atomicity that a host-global
    file (`op-log`, `build-progress`, `check-progress`) relies on to interleave
    lines from concurrent processes — a CLI writing one keeps `appendSync`, one
    line per call. The async queue folds only the lines queued during one write
    (a backend's few op-log terminals), still one small append.
  - An empty batch writes nothing and creates neither the file nor its directory.
  - The parent dir is created **on the write's `ENOENT`**, not before every write
    (for flag `"a"`, `ENOENT` means only "a path component is missing"). Same
    self-healing if a live backend's logs dir is deleted, zero `mkdir` syscalls in
    the steady state, and no `Set` of "already ensured" dirs — that would cache a
    belief a worktree teardown can falsify.
- **`defineFileSink(spec) → FileSink`** — registers the sink and returns it. A sink
  is **declared exactly once**: a duplicate `id` throws (mirroring
  `declareGrowthBound`), because two owners claiming one id is an authoring bug.
  `getFileSinks()` then exposes it as part of the true, enumerable set of sinks.
  A sink does **not** declare who reads it (see below).
- **`getFileSinks() → ReadonlyMap<string, FileSink>`** — a **copy** of the
  registry, never the live map. Its consumer is, later, the undeclared-growth
  monitor (which joins it with retention's `getTableGrowthBounds()`).
- **`openDynamicSink(dir, name) → FileSink`** — for the ONE genuinely open-ended
  family: browser-supplied `clientLog` channel ids. Same rotation, but `name` is
  **sanitized** into `dir` (path-traversal guard — every non-`[A-Za-z0-9_-]` char
  becomes `_`) and the sink is **NOT** added to the registry. The whole family is
  covered by a single declared bound (registered once by the log-channels plugin),
  so registering each dynamic id would make the registry itself unbounded.
  `defineFileSink` does **not** sanitize — its `path` is caller-owned and trusted.
- **`sanitizeChannel(name) → string`** — the traversal guard itself, exported so a
  caller that must derive the same on-disk filename (log-channels' read path) shares
  one regex instead of hand-copying it.

## Reading — the bounded counterpart of `append()`

A sink owns its file's growth, so it also owns how you read it back. Lifted from
`log-channels`'s `readTail`: a **positioned** `openSync`/`fstatSync`/`readSync` of
the last N bytes, so even a full 128 MB live file is never materialized whole in
memory. When the read didn't start at offset 0 the first line is (probably)
partial and is dropped.

- **`readTail(path, opts?) → TailResult`** and **`sink.readTail(opts?)`** — raw
  lines, oldest-first.
- **`readJsonlTail<T>(path, opts?) → JsonlTailResult<T>`** and
  **`sink.readJsonlTail<T>(opts?)`** — the same, with each line `JSON.parse`d.
  `T` is an **unchecked assertion**: this plugin imports nothing but `node:fs` /
  `node:path` (no zod), so schema validation stays at the caller.

The **free** functions are not a convenience — they are how you read a *frozen
legacy file* that has no sink and must never get one (declaring a `rotate` bound
for a file nothing writes would be a false entry in the growth-bound registry).
The **method** form removes the chance of reading a sink from the wrong path.

```ts
type TailOptions = {
  maxBytes?: number;       // byte budget pulled off disk. Default 8 MB.
  maxLines?: number;       // cap on returned lines, NEWEST kept. Default unbounded.
  includeRotated?: boolean;// walk path.1, path.2, … until the budget is met. Default false.
};
type TailResult =
  | { kind: "missing" }
  | { kind: "read"; lines: string[]; truncated: boolean; filesRead: number };
```

- **A missing file is `{ kind: "missing" }`, never `[]`.** Collapsing it makes "no
  file has ever been written here" indistinguishable from "present but empty" —
  the repo's absorbed-failure rule. Callers that want empty write one visible line.
- **`truncated: true`** whenever the budget clipped history (the oldest opened
  file wasn't read from offset 0, a further rotation existed but wasn't opened, or
  `maxLines` dropped lines), so a partial window can never be presented as complete.
- **A `SyntaxError` on a line is skipped; every other error rethrows.** The skip
  covers exactly the torn-tail case; anything else is a real bug.
- **The read budget is never derived from `bound.maxBytes`** — that would default
  a standard sink to a 512 MB read.
- **`includeRotated` is opt-in, default off.** A tail wants the live file; a
  *reconstructing* reader wants history. Stitching concatenates **oldest-first** so
  line order stays chronological, dropping the leading partial line only for the
  oldest file actually opened. Safe because every write — `append` and `appendAll`
  alike — puts down a whole number of `\n`-terminated lines and rotation happens
  *between* two of them, so **a line is never split across a rotation**, batch or
  not.

## Reading the whole history — `readHistory` / `statHistory` / `historyCutAt`

`readTail` answers "the last few MB". A viewer that pages back through a log
needs "the lines before this one" at any depth, across rotations — otherwise its
history silently ends at the live file's first line.

- **A line's position is `(file birth µs, byte offset)`**, spelled as fixed-width
  text whose code-point order IS the line order. A generation number or a byte
  offset alone stops naming a line at the next rotation (live → `.1` → `.2`); a
  file's birth time does not — `rename` keeps the inode — and a later-born file
  holds later lines. So a position taken before a rotation still names the same
  line after it: exactly the cut a key-range-paged live value needs
  (`debug/logs`'s `debug.logs.lines`).
- **`readHistory(path, { before, notBefore, limit })`** — the lines strictly
  older than `before` (`null` = from the newest) down to `notBefore`, newest
  first, at most `limit`: an async backwards chunked read that crosses from a
  file into the next older one and stops once it has `limit` lines, so a page
  costs what it returns at any depth. A live file's unterminated tail (an append
  in flight) is not a line yet.
- **`statHistory(path)`** — the files that exist (live, `.1`, `.2`, … up to the
  first missing), with size, birth and last write: what a catalog shows. Works
  for any rotated file with the `path.N` convention — the gateway's backend
  captures included.
- **`historyCutAt(path, atMs, timeOf)`** — the cut just after the newest line at
  or before an instant (newest file whose first line is not later, then a binary
  search of its bytes), for "open this log at the time the report fired".
- A filesystem that reports no birth time cannot order a history; the read
  throws rather than guess.

## Boundaries

**`core/` here means runtime-neutral Node, not web-safe** — this plugin's `core/`
reaches `node:fs` / `node:path`, and **it must never be imported from `web/`.**
The impl lives in `core/` on purpose: runtime isolation gives a `core/` file only
`core → core`, so hosting the chokepoint in `server/` put it out of reach of the
CLI runtimes that most need it (the check runner) and left hand-rolling an append
as the only escape. Being importable from every runtime *is* the feature.

- `core/` — everything: the types, `defineFileSink` / `getFileSinks` /
  `openDynamicSink` / `sanitizeChannel`, and the `readTail` / `readJsonlTail`
  readers.
- `server/` — the plugin's server-runtime presence only. **No re-exports** — import
  from `core/`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Bounded-append file sink primitive: defineFileSink declares an absolute-path sink that rotates at a byte cap (default 128 MB × 3), true by construction because append() IS the rotation. Node-only (no db/jobs) so a CLI process can import it. getFileSinks exposes the registered set; openDynamicSink covers the open-ended browser clientLog family under one declared bound.
- Core:
  - Uses:
    - `infra/host-fs/user-path.AppPath`
    - `infra/host-fs/user-path.appPathParent`
    - `infra/host-fs/user-path.asAppPath`
    - `infra/host-fs/user-path.joinAppPath`
    - `packages/coalesce.createKeyedCoalescer`
    - `packages/owned-fd.openOwnedFdSync`
    - `packages/owned-fd.OwnedFd`
    - `packages/timed-fs.stat`
    - `packages/timed-fs.statSync`
  - Exports (types):
    - `FileSink`
    - `FileSinkSpec`
    - `HistoryFile`
    - `HistoryLine`
    - `HistoryRange`
    - `JsonlTailResult`
    - `RotateBound`
    - `TailOptions`
    - `TailResult`
  - Exports (values):
    - `defineFileSink`
    - `flushQueuedAppendsSync`
    - `getFileSinks`
    - `historyCutAt`
    - `isHistoryPosition`
    - `openDynamicSink`
    - `readHistory`
    - `readJsonlTailAsync`
    - `readJsonlTailSync`
    - `readTailAsync`
    - `readTailSync`
    - `sanitizeChannel`
    - `settleFileSinkWrites`
    - `statHistory`
- Cross-plugin:
  - Imported by:
    - `debug/boot-events`
    - `debug/logs`
    - `debug/profiling/fs-wait`
    - `debug/profiling/op-log`
    - `framework/cli/op-runtime`
    - `framework/tooling/checks`
    - `packages/signal-origin/sink`
    - `primitives/log-channels`
    - `primitives/log-channels/log-files`
- Exemptions:
  - Exempts itself from:
    - `sink-safety/no-adhoc-file-sink` — `.` (sanctioned)
    - `boundaries/no-platform-api` — `core/internal/file-sink.ts`, `core/internal/history.ts`, `core/internal/read.ts` (debt)
    - `blocking-fs/no-sync-fs` — `server/internal/exit-flush.ts` (sanctioned)
- Server:
  - Register: `file-sink-exit-flush`

<!-- AUTOGENERATED:END -->
