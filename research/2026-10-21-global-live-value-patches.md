# Live value patches — a pushed value's change ships as what changed

Follows `research/2026-10-21-conversations-stream-every-block.md` (its *Cost*
section named this as the follow-up).

## Context

`conversations.partial-message` (served in
`plugins/conversations/machine/internal/partial-message.ts`, throttled to one
push per 50 ms) is a plain pushed `liveValue`: every push is an `update` frame
carrying the WHOLE in-flight message. Since every block streams (thinking,
text, tool input), a `Write` of a 30 KB file re-ships everything written so
far on every push — up to ~20 × the message size per second to every open
page, and a cost quadratic in what is written. On the page each push is a
full `JSON.parse` in the SharedWorker, a structured clone to the tab, a zod
parse, new objects for every block, a fresh stand-in event per block
(`standInsOf`), a full `parsePartialJson` of the tool input and a re-render
of every stand-in.

The live substrate already has a proportional wire for **keyed** resources
(row deltas), but a value is a snapshot and its only frame is `update`.
Chunking the message into keyed rows would fit the existing wire but is an
encoding hack (membership deltas re-ship the full `order`, the tail chunk is
re-sent each push). The clean primitive is generic: **a pushed value may
declare that its changes ship as patches against the value every holder
holds**. Any growing value (a shell's output tail, a sub-agent's activity)
can then opt in.

## Measure first

New e2e `jsonl-viewer/e2e/stream-cost.ts`: a throwaway conversation writes a
~30 KB file with `Write`; context A (socket tapped through
`networking/e2e`'s `tapSharedSocket`) records every partial-message frame
(count, bytes, largest, amplification = bytes shipped ÷ tool-input size);
context B (untapped) reads CDP `Performance.getMetrics` over the stream
window (script / layout / style ms per second); the script re-parses every
prefix the page parsed with `parsePartialJson` to price it. Run before and
after; numbers go in *Results* below.

## Design

### 1. `packages/value-patch` (new leaf, core)

- `diffValue(prev, next): ValuePatchOp[] | null` — JSON-level structural diff;
  `null` when the change is the root itself (the caller ships the whole
  value). Ops: `{ at: Path, set: v }`, `{ at, append: string }` (a string
  that grew by a suffix), `{ at, push: v[] }` (an array that grew). Objects
  recurse by key (a changed key set → `set` of the object); arrays recurse on
  the common prefix, extra elements → `push`, a shorter array → `set`.
  `undefined` keys are absent (as in JSON); a non-plain object is a leaf
  compared by its JSON.
- `applyValuePatch(base, ops)` — copy-on-write along each op's path: every
  untouched subtree keeps its identity (so a block that did not change keeps
  its object). Throws on a path the base does not hold (a broken base is
  loud).
- Pure, `*.test.ts`: `apply(prev, diff(prev, next))` deep-equals `next` over
  random JSON; identity kept off the changed paths.

### 2. Protocol (`packages/resource-protocol`)

New server frame `patch { key, params, base, version, ops, watermark?, ackTx?,
timing? }` — `base` is the version the ops apply to. No etag (an etag rides
only a frame carrying the value). `PROTOCOL` moves (pinned test updated).

### 3. Declaration (`network/live` + live-state core)

`liveValue(key, { …, patches: true })` on a pushed value (not `on-demand` /
`snapshot` / `bytes` / `paged` / preloaded — tsc and a throw). Declared on the
shared descriptor because both ends act on it (as `load` is): the descriptor
carries `patches: true` (`ResourceDescriptor.patches`), the client keeps a
wire base for those keys only, the runtime entry patches only those.

### 4. Runtime (`resource-runtime`) — one version, one value

Per patch entry and tuple, `patchBases: pk → { version, value }`: the wire
value every holder at `version` holds.

- **Drain** (`sendUpdate`): with a base, `diffValue(base.value, value)`; ops →
  `patch { base: base.version }`, `null` → `update`. Either way the base
  becomes `{ version, value }`. A loader failure, and N→0, drop the base (the
  next frame is a full `update`).
- **Sub-ack while a base exists**: answered FROM the base (its value at its
  version, no load). That is what keeps "one version, one value" true for
  every holder: a tab joining mid-stream holds exactly what the others hold,
  and the next patch applies to it. Any change since is a notify already
  pending, so the next drain patches it forward.
- **Sub-ack with no base** (the span's first subscriber): a normal load; it
  becomes the base only while that holder is the tuple's sole one and no drain
  minted since (D8's sole-holder rule, `noteRead`) — otherwise the next drain
  ships a full `update`.
- Refused at registration: `patches` beside `revalidate`, a persisted entry,
  a non-push mode.

### 5. Client (`live-state` `NotificationsClient`)

- `ActiveSub.wire`: the last wire value applied for a patches key (sub-ack /
  update / patch); an HTTP write and `forceFullResub` clear it.
- `patch`: after the stale-version gate and BEFORE the version adoption —
  `entry.version === msg.base` and a wire base held, else `forceFullResub`
  (`patch-base-resub` trace). Then `applyValuePatch(wire, ops)` → the same
  write path as `update` (schema parse, watermark/acks, `setQueryData`,
  latency sample).

### 6. Partial message

- `conversationPartialMessage` declares `patches: true`.
- `standInsOf`: each block's stand-in event memoized by block object (a
  `WeakMap`), so an unchanged block keeps its event and its row does not
  re-render; the tool input is parsed only when its block changed (live-state's
  structural sharing keeps an unchanged block's object across the parse).

## Files

- new `plugins/packages/plugins/value-patch/core/{index.ts,internal/value-patch.ts,internal/value-patch.test.ts}`
- `plugins/packages/plugins/resource-protocol/core/internal/frames.ts` (+ test pin)
- `plugins/framework/plugins/resource-runtime/core/runtime.ts` (+ a `runtime-patch.test.ts`)
- `plugins/primitives/plugins/live-state/{core,web/notifications-client.ts}` (+ a client test)
- `plugins/network/plugins/live/core/internal/live-value.ts`, compile path
- `plugins/conversations/core/partial-message.ts`, `jsonl-viewer/web/streaming-blocks.ts`
- `jsonl-viewer/e2e/stream-cost.ts`

## Verification

- `./singularity test` on value-patch, resource-protocol, resource-runtime,
  live-state, network/live, jsonl-viewer.
- `./singularity build`, then `stream-cost.ts` before/after;
  `stream-order.ts` and `assistant-text/e2e/first-token.ts` still pass.

## Results

`stream-cost.ts --kb 30`, one Sonnet turn writing a ~40 KB file, same machine:

| | Before (whole value) | After (patches) |
|---|---|---|
| Tool input written | 36.6 KB | 41.1 KB |
| Partial-message bytes shipped | 26 407 KB | 124 KB |
| Amplification (shipped ÷ written) | 721× | 3.0× (frame headers) |
| Largest frame | 37.1 KB | 0.5 KB |
| Wire rate | 254 KB/s | 1.1 KB/s |
| Page script time per s of stream | 65 ms | 30 ms |
| Page task time per s of stream | 117 ms | 79 ms |

`parsePartialJson` over every prefix the page parsed: 0.14–0.20 ms per push
(~3 % of the page's script time) — not the cost, so it stays a full parse;
the per-block stand-in memo keeps it to the block that grew. The rest of the
remaining page time is the page's own rendering of the growing stand-in.
`stream-order.ts` passes; the `live-state` log shows no `patch-base-resub`.
