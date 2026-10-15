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
  description: "`./singularity build` step timings, read by the Profiling Gantt",
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
cost on this synchronous hot path) and, when the next line would cross `maxBytes`,
rotates `path` → `path.1`, `path.1` → `path.2`, …, drops `path.keep`, then writes
the line into a fresh live file. So a sink that *exists* is a sink whose file is
bounded; there is no "declared but unbounded" state. `appendAll` shares that one
implementation and one gate — see below — so a batch is bounded identically. This
is why
`retention.getGrowthBounds()` can merge every registered sink's `bound` in as a
real growth bound without verifying anything (see `../retention/CLAUDE.md`).

Rotated files are `path.N` — the suffix is appended **after** the full path (a
`foo.jsonl` live file rotates to `foo.jsonl.1`), so a `endsWith(".jsonl")` listing
filter naturally excludes the rotations.

## API

- **`sink.append(line)` / `sink.appendAll(lines)`** — one line, or a whole batch as
  ONE `appendFileSync`. Both are the *same* function (`appendLines`) with one size
  gate, so `appendAll(lines)` is byte-for-byte `for (const l of lines) append(l)`.
  Keep it that way: two gates is how "a line is never split across a rotation"
  would drift apart between the two forms.
  - The gate runs **per rotation group**, not per batch (a batch has no length or
    byte cap — the browser supplies it) and not per line. Lines accumulate until
    the next one would cross `maxBytes`; that group goes out as one write, *then*
    the file rotates. So a batch bigger than `maxBytes` rotates several times
    inside the one call and `keep` stays a hard cap.
  - **`appendAll` is for SINGLE-WRITER files only.** One batched write is not
    covered by the `O_APPEND` whole-line atomicity that a host-global file
    (`op-log`, `build-progress`, `check-progress`) relies on to interleave lines
    from concurrent processes — those must keep using `append`, one line per call.
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
  registry, never the live map. Its consumer is `retention` (which merges each
  sink into `getGrowthBounds()` under `file:${id}`) and, later, the
  undeclared-growth monitor.
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

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Bounded-append file sink primitive: defineFileSink declares an absolute-path sink that rotates at a byte cap (default 128 MB × 3), true by construction because append() IS the rotation. Node-only (no db/jobs) so a CLI process can import it. getFileSinks exposes the registered set; openDynamicSink covers the open-ended browser clientLog family under one declared bound.
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `framework/tooling/checks`
    - `packages/signal-origin/sink`
- Exemptions:
  - Exempts itself from: `sink-safety/no-adhoc-file-sink` — `.` (sanctioned)
- Core:
  - Exports (types):
    - `FileSink`
    - `FileSinkSpec`
    - `JsonlTailResult`
    - `RotateBound`
    - `TailOptions`
    - `TailResult`
  - Exports (values):
    - `defineFileSink`
    - `getFileSinks`
    - `openDynamicSink`
    - `readJsonlTail`
    - `readTail`
    - `sanitizeChannel`

<!-- AUTOGENERATED:END -->
