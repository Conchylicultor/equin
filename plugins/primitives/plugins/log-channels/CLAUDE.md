# log-channels

The persistent log-channel substrate. Browser and server code can emit named log
lines that persist to disk per worktree, decoupled from the live-state WebSocket
(the emitter flushes over plain HTTP), so logs still get through even when the
live-state pipeline is wedged. `debug/logs` is the read-only viewer on top of this.

## Durable vs ephemeral channels

Durability is a **declaration**, not a flag. There is no `persist` option: a
channel either declares a durable file sink or it doesn't.

- **Durable (server):** `defineLogSink({ id, description }).publish(line, stream?, t?)`
  from `@plugins/primitives/plugins/log-channels/server`. This registers the
  channel AND a `defineFileSink` under the per-worktree logs dir (declared at
  import, its path resolved lazily on first use) — one declared, enumerable, 128 MB × 3-rotation growth bound
  (`@plugins/infra/plugins/file-sink`, merged into `retention.getGrowthBounds()` as
  `file:<id>`). The `description` is what makes a perf sink (`health`,
  `health-host`, `slow-op-markers`) distinguishable from an ops log in
  `getFileSinks()`. A channel never declares who reads it — alerting belongs to
  the code that detects the failure (see `infra/file-sink`, *A sink is
  evidence, not a signal*). Declared **exactly once** per id — a channel written from two
  modules hoists ONE `defineLogSink` into a shared module and imports it from both
  (a duplicate id throws). The sink is DECLARED at import — so `getFileSinks()`
  (and Debug → Logs) know every channel, with its description, before it writes
  a line — but its PATH resolves lazily, so declaring one is **import-safe** (the
  process's runtime namespace is not resolved at module eval — the barrel is
  imported inside the import-safe `@plugins/database/server` graph).
  A caller holding an ARRAY of lines calls `publishAll([{ line, stream?, timestamp? }])`
  instead of looping. `publishAll` is the single implementation and `publish`
  delegates to it with a one-element array, so the two can never drift. One
  `publishAll` is one ring trim and **one** `appendAll` file write, whatever the
  batch size; per-line WS delivery is unchanged (one listener callback per line, in
  order). The order inside it is ring → sink → listeners, so "durable before
  broadcast" holds per batch.

- **Ephemeral (server):** `Log.channel(id).publish(...)` — in-memory ring buffer
  only, no disk.
- **Browser:** `clientLog(channel, line)` from
  `@plugins/primitives/plugins/log-channels/web` → `POST /api/logs/emit`. The
  ingress persists via `openDynamicSink` (the one open-ended, browser-supplied
  channel family, covered by the single declared `client-log` family bound). The
  route-internal `emitClientLogs` is the ONLY persist-from-arbitrary-input path; it
  is **not** exported from the barrel. It takes the whole validated request body
  rather than one line — the array is the unit at every layer, so **one POST is
  one file write** (a 500-line batch used to be ~2000 blocking syscalls on the
  event loop) and there is no singular entry point left for a handler to loop over.

Durable channels append to `~/.singularity/worktrees/<wt>/logs/<channel>.jsonl`,
one JSON object per line: `{"t":<ms>,"stream":"stdout"|"stderr","line":"..."}`. The
file survives the backend restart that `./singularity build` performs mid-build;
the in-memory ring buffer only backs the live UI pane.

## Viewing a channel live

`<LiveLogChannel channel="…" />` (web barrel) is **the one implementation** of
"show me this channel as it happens": the `/ws/logs` subscribe, the sequence
de-dup, the sticky-scroll with its jump-to-bottom off-ramp, the copy button and
the timestamped row markup. Five surfaces used to carry their own copy of that
body; two of them (the build toolbar popover, the build run-detail section) were
still carrying it, and the popover's copy subscribed twice on mount, so the
server replayed the ring buffer a second time and every build line appeared
twice.

The subscription is the cost of mounting it, so a surface that wants the section
present but **shut** passes `disclosure="closed"` instead of hiding it with CSS:
the header becomes a chevron row, the list unmounts, and the socket closes with
it. Reopening resumes from the last sequence already on screen (`fromSequence`),
so the tail is never replayed. `disclosure` is an INITIAL state — a later change
does not reopen a section the reader closed.

### Reading logs

`tail`/`cat` the `.jsonl` file directly. This plugin owns only the **read** path
(`readChannelEntries`, `listChannels`); the **write/rotation** half lives in
`@plugins/infra/plugins/file-sink`.

Server-side, `readChannelEntries(worktree, channel, tail)` returns the last
`tail` envelope rows (`{ t, stream, line }`), or `null` for a missing channel.
Most consumers store one JSON object per line and want it back typed — for that
use `readChannelJson(worktree, channel, tail, schema)`: it unwraps each
envelope's `line`, tolerantly `JSON.parse`es it (a torn tail line is skipped),
`schema.safeParse`-drops invalid rows, and returns the valid `T[]`. A
missing/empty channel collapses to `[]`; a caller that must distinguish "no
channel yet" from "channel present but empty" uses `readChannelEntries` (which
returns `null`) directly. (Callers keep their own tail cap and any post-read
window/cutoff/pairing.)

### Rotation

The file sink rotates each channel's live file at a **128 MB** cap, gated on an
in-memory per-file byte counter (no `statSync` per append). It keeps **3** rotated
files named `channel.jsonl.N` (suffix appended *after* `.jsonl`, so `listChannels`
excludes them); the oldest is unlinked. `readChannelEntries` currently reads **only**
the live `channel.jsonl`, so a tail that spans a just-rotated boundary is truncated to
the current file — acceptable at 128 MB. If full history across a rotation is ever
needed, extend it to fall back across `channel.jsonl.1…N`.

### Backpressure: the endpoint can say "stop"

`POST /api/logs/emit` answers **`{ status: "paused", reason: "duress" }`** while
the host-global duress latch is set (`isUnderDuress()` from
`@plugins/infra/plugins/host/plugins/duress/plugins/latch/server`, one read per
request, memoized to at most one `statSync` per 2 s), and `{ status: "accepted" }`
otherwise. This is the one observability channel whose volume driver is
*external* — a browser that keeps POSTing regardless of host state — so during an
episode the whole request is refused before the ring pushes, the file write and
the WS fan-out.

**A typed 200, never an error status.** The browser prints "Failed to load
resource" for every non-2xx response (a 429 used to fill the console for the
whole episode), and the client-side endpoint-error reporter files a crash report
for every `status >= 500` (a 503 would set off a report storm *during* duress —
the storm-suppression mechanism causing one). The refusal is expected and
lossless, so it is an arm of the response type, not a failure.

Nothing is lost. `clientLog`'s buffer re-queues the rejected batch in order and
retries it — and the retry honours the backoff. A rejected POST ends the flush pass
and sets a **hold** whose single timer (armed on the failure edge, never a poll) is
the only thing that flushes next: 5 s after a plain failure, 30 s after a `paused`.
While held, new `clientLog` lines only buffer and WS `open` events send nothing;
the one exception is that an `open` lifts a plain-failure hold (the backend is back),
never a `paused` hold (the duress latch is host-wide; a reconnect says nothing about it).
Flushes are **single-flight**: a trigger while one runs marks it dirty and it goes
round once more, so batches never interleave or reorder. Do not add a flush trigger
that bypasses `requestFlush` — several sockets publish WS `open`, and each bypass
re-POSTs straight into the pause. That buffer is also capped per channel (4 000 lines,
**drop-oldest** — the opposite of the server shed buffer's drop-newest, because
the browser has no first-N-durable guarantee and its newest lines describe the
problem the user is looking at). A drop is never silent: one
`[clientLog] dropped N lines under backpressure` line takes the head slot, and its
count accumulates across drops.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Persistent log-channel substrate: clientLog browser emitter that buffers and flushes log lines over plain HTTP to the per-worktree JSONL files. Server barrel owns Log/persist/registry and the /api/logs/emit + /ws/logs routes; debug/logs is the viewer.
- Load-bearing: yes
- Web:
  - Uses:
    - `infra/endpoints.fetchEndpoint`
    - `primitives/collapsible.CollapsibleContent`
    - `primitives/collapsible.CollapsibleProvider`
    - `primitives/copy-to-clipboard.CopyButton`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/pin.Pin`
    - `primitives/css/row.SectionHeaderRow`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/text.textVariantClass`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/dom/auto-scroll.JumpToBottomButton`
    - `primitives/dom/auto-scroll.useStickyScroll`
    - `primitives/networking.subscribeWsStatus`
    - `primitives/networking.useReconnectingWebSocket`
    - `primitives/networking.wsUrl`
  - Exports (types): `LiveLogChannelProps`
  - Exports (values):
    - `clientLog`
    - `LiveLogChannel`
- Server:
  - Uses:
    - `infra/endpoints.implement`
    - `infra/host/duress/latch.isUnderDuress`
    - `infra/paths.worktreeDataDir`
  - Exports (types):
    - `LogChannel`
    - `LogStream`
  - Exports (values):
    - `clientLogFamily`
    - `defineLogSink`
    - `listChannels`
    - `Log`
    - `logsDir`
    - `logsDirFor`
    - `readChannelEntries`
    - `readChannelJson`
    - `readChannelJsonAsync`
  - Routes:
    - `POST /api/logs/emit`
    - `/ws/logs (WS)`
- Core:
  - Uses: `infra/endpoints.defineEndpoint`
  - Exports (types):
    - `ClientMessage`
    - `EmitLogsBody`
    - `EmitLogsResult`
    - `EntryMsg`
    - `ErrorMsg`
    - `HistoryMsg`
    - `LogEntryWire`
    - `ServerMessage`
    - `SubscribeMsg`
  - Exports (values):
    - `emitLogs`
    - `EmitLogsBodySchema`
    - `MAX_EMIT_LINES`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --destructive`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`
  - Imported by: 55 plugins — full list in [REFERENCE.md](./REFERENCE.md)
    - `debug` ×12
    - `apps` ×11
    - `infra` ×8
    - `database` ×7
    - `conversations` ×4
    - `build` ×2
    - `tasks` ×2
    - `backup`
    - `integrations/youtube/audio-fetch`
    - `network/live`
    - `page/annotations/agent-access`
    - `primitives/live-state`
    - `release`
    - `reports/render-loop`
    - `stats/cost`
    - `upstream`

<!-- AUTOGENERATED:END -->
