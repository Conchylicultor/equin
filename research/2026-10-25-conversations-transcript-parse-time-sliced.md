# Transcript parse never holds the event loop: time-sliced `TranscriptLines`

## Context

The first read of a conversation's transcript chain parses every JSONL line in
one synchronous loop (`TranscriptLines.append`, then `buildJsonlEvents`). A stall
trace on 2026-10-25 (att-1792927501-xb3gx6, 12:52:48) blocked the server's event
loop for **10.5 s**: JSON.parse ~30 %, base64 image sizing ~15 %, UTF-8 decoding
~12 %, XML parsing (task notifications). Every request and live update on that
backend — main included — waits behind it.

Rate × cost: the rate is "first read of a big chain" (cold room, server restart,
a rewind/replace forcing a full re-read); the cost is O(chain bytes) of
synchronous CPU. We cannot make a 50 MB parse free, but nothing requires it to
run as ONE task. The origin is the shape of the API: `append(file, offset,
bytes)` is synchronous and takes the whole chunk, so a host has no way to read
a big file without a single giant loop.

## Findings (after the plan)

The trace (`traces` f7790db5 in att-1792927501-xb3gx6, 11:53:03Z) fired during
that backend's **boot**: many rooms read cold at once. A single 52 MB chain
parses in ~120 ms; the 10.5 s was the sum. A second stall there (13:02, 4.1 s)
was `extractTaskNotifications ← buildJsonlEvents`. So per-task slicing is not
enough: N slicers that yield together resume back to back in one turn. Every
transcript slicer therefore yields through ONE shared `createTurnQueue()` —
`createTimeSlicer(budgetMs, yieldTurn)` gained the `yieldTurn` parameter.

## Design

### 1. `TranscriptLines` becomes async and time-sliced (the fix)

- `append` → `async`. Its line loop calls `await slice()` per line, with
  `createTimeSlicer(10, transcriptTurns)` (one shared turn queue, see Findings) from `@plugins/packages/plugins/macrotask-yield/core`
  (existing primitive, 10 ms budget, already used by plugin-tree / token-usage).
  The loop then yields a macrotask every ~10 ms instead of holding it for seconds.
- `buildJsonlEvents` (already async) gets the same slicer in its main
  `for (const obj of parsed)` loop, so the XML / text processing phase is sliced
  too. `activeLineUuids` stays a single pass (cheap, map-only); measure, slice
  only if it shows up.

### 2. `TranscriptLines` serializes its own mutations (made necessary by 1)

Today `readChain` reads `consumed(file)`, awaits the bytes, then appends — two
concurrent reads of one room (the seed `refreshRoom` at watcher.ts:220 and the
`refreshOn` path at :247 run outside the `roomRuns` coalescer) can both start at
the same offset, and the second `append` throws. With yields inside `append`
that window becomes wide, and `events()` could also build mid-append.

Rung 1 fix — make the mismatch inexpressible: the lines own "where to read
from", the host only supplies bytes.

```ts
/** Catch `file` up to `size` bytes: reads [consumed, size) through `read`, decodes its complete lines. */
catchUp(file: string, size: number, read: (from: number, to: number) => Promise<Uint8Array>): Promise<number>
```

- Every `catchUp` and `events()` call runs on one internal promise chain
  (FIFO), so `consumed` is read, the bytes fetched and the lines decoded with no
  interleaving, and `events()` sees every catch-up requested before it.
- A `catchUp` whose `size <= consumed` is a no-op (the concurrent duplicate read
  becomes harmless instead of a throw).
- The `offset` parameter and its mismatch error go away; `consumed()` stays as a
  read for `continues()`.
- Callers: `transcript-watcher` `readChain` (`Bun.file(path).slice(from, to).bytes()`),
  `memory-transcripts` (`() => jsonl`), `mergeChainLines` (becomes async; only
  tests use it), the bench script.

### 3. Cut the per-image cost (cheap, independent)

`base64Bytes` decodes via `Uint8Array.from(atob(s), c => c.charCodeAt(0))` — a
JS callback per byte. `Uint8Array.fromBase64` (Bun 1.4, every current browser)
is ~35× faster (3 MB: 98 ms → 2.9 ms, measured). Switch `base64Bytes` to it
(narrowly typed off `Uint8Array` if the TS lib lacks it). Covers both the
header sizing and the JPEG full-decode fallback, and `readImageKey`'s line-image
read.

### Not doing

- **Worker thread**: removes the loop cost entirely but the parser is portable
  (browser worker host too), needs the image reader across a port, and ships
  events back through structured clone — itself a main-thread cost. Time-slicing
  bounds the stall at ~10 ms with no new runtime boundary.
- Skipping/streaming JSON.parse of image-heavy lines: one huge line is still a
  single parse (tens of ms worst case); acceptable at that bound.

## Files

- `plugins/conversations/plugins/transcript-source/server/internal/transcript-lines.ts` — async `catchUp`, internal queue, slicer.
- `.../transcript-source/server/internal/parse-jsonl.ts` — slicer in `buildJsonlEvents`.
- `.../transcript-source/server/internal/image-key.ts` — `fromBase64`.
- `plugins/conversations/plugins/transcript-watcher/server/internal/parse-jsonl.ts` — `readChain` uses `catchUp`.
- `.../transcript-source/plugins/memory/server/internal/memory-transcripts.ts`, `.../transcript-source/scripts/transcript-delivery-bench.ts` — callers.
- Tests: `transcript-lines.test.ts` (async; new: concurrent `catchUp` at the same size decodes once; `events()` after a pending `catchUp` includes it), `parse-jsonl.test.ts` if it uses `mergeChainLines`.
- `transcript-source/CLAUDE.md` — note the slicing + serialization contract.

## Verification

- `./equin test plugins/conversations/plugins/transcript-source plugins/conversations/plugins/transcript-watcher`.
- Bench on the largest local transcript (`~/.claude/projects/**`, the stalled
  conversation's chain if present): `./equin run .../transcript-delivery-bench.ts <file>`
  — total full-read time roughly unchanged, plus a max-gap measure (a
  `setInterval(…, 1)`-style lag probe in the bench, max loop lag during the cold
  read) dropping from seconds to ≈ the slice budget.
- `./equin build`, open a big conversation cold on the worktree deploy, confirm it renders.
