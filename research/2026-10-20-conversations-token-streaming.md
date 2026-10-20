# Token streaming (SDK Claude Phase 2, step 4)

Track: wiki *Mental model → Agent Manager → SDK Claude*, sub-page *Phase 2:
transcript delivery and streaming*, step 4. Steps 1–3 (paged transcript,
images by URL, incremental reads) are on main
(`research/2026-10-20-conversations-transcript-delivery-phase2.md`).

## Context

The page draws the CLI's JSONL transcript, and the CLI writes an assistant
line only once a content block is finished. So nothing appears while the
model writes, and a long answer arrives all at once. The agreed design (user,
2026-10-20): partial text goes over the agent's socket, not into
`events.jsonl`, into a short-lived live value per conversation. The page draws
it as a temporary block and drops it once the finished transcript line with the
same message id arrives. A backend restart mid-message loses only the partial
text.

Also in this session: remove the `@singularity-host` tmux mark (user decision:
no need to wait for the Phase-1 checkouts).

## Where things stand

- `runtime-sdk/bin/agent.ts`: `query()` without `includePartialMessages`;
  every SDK message goes to `events.jsonl` via `emit`. The socket is strictly
  request/response: one reply per command, no list of connections.
- Backend side (`runtime-sdk/machine/internal/socket-client.ts`): a fresh
  connection per command (`exchange`), opened with `hello`; a version mismatch
  is refused. No long-lived connection to any agent.
- `ConversationRuntime` (`conversations/server/internal/runtime.ts`) is the
  runtime-neutral contract; `Runtime.get(row.runtime)`.
- `network/live`: `serveValue(…, { source: "external", changes: "notified",
  loader, whileSubscribed, throttleMs })` is the in-memory arm;
  `serveTranscriptValue` (jsonl-viewer) is the precedent.
- Page: `JsonlPaneInner` fills `TranscriptView`'s end slot with
  `JsonlViewer.TranscriptEnd` contributions, then `WorkingIndicator`, the
  pending prompt and the pending turn echoes. `useTranscriptEvents()` gives the
  drawn window. An `assistant-text` event carries `messageId` (the API's
  `msg_…`) and the merged text of that message's text blocks;
  `AssistantTextRow` draws it with `Markdown`.

## Design

### 1. Agent: partial state and a subscribe stream (`bin/agent.ts`, `core/protocol.ts`)

- `includePartialMessages: true`. `stream_event` messages are **not** written
  to `events.jsonl` (the decision; they would multiply the file and are useless
  on replay). They are logged nowhere else.
- The agent folds top-level stream events (`parent_tool_use_id === null`) into
  one `PartialMessage`: `{ messageId, blocks: [{ index, text }] }`, text blocks
  only (`content_block_start` type `text`, `text_delta`). Thinking and tool
  input are out of scope.
  - `message_start` starts a new one (the previous message's blocks have
    landed or are about to; the page hides landed ones, below).
  - Cleared on `turn_started`, on `interrupt`, and on an error `result`
    (an interrupted or failed message never lands, so its text must not stay).
  - Kept on a successful `result`: its text lands in the transcript a few ms
    later and the page hides it then; clearing first would flash a gap.
- New command `subscribe`: the connection stays open; the agent writes a
  `snapshot` frame (the current `PartialMessage | null`), then `delta` frames
  (`{ messageId, index, text }`) and `reset` frames as they happen. The agent
  keeps a `Set` of subscribed connections, dropped on close.
- Compatibility: agents outlive deploys. `PROTOCOL_VERSION` stays 2 (bumping it
  would make every running agent refuse every command). The `hello` reply gains
  an optional `stream: true` capability; the backend subscribes only when it is
  there. An agent started before this change answers without it, and its
  conversation simply does not stream until its next resume.

### 2. Runtime contract and the backend hub

- `ConversationRuntime.watchPartial(id, onChange): () => void` — runtime
  neutral, required (only `sdk` exists; a future runtime states what it does).
  `onChange` receives `PartialState`:
  `{ kind: "none" } | { kind: "streaming", message: PartialMessage }`.
  ("Agent not running" and "agent predates streaming" are both `none` to the
  reader: there is nothing to draw; the hub knows the difference and logs it.)
- runtime-sdk `machine/internal/partial-stream.ts`: a refcounted hub
  (`packages/refcount-hub`) keyed by conversation. First watcher: `hello` and,
  if capable, open one `subscribe` connection; fold frames into the held state;
  notify watchers. Last watcher: close the connection.
- Reconnect without polling: when the connection closes (agent exited) the
  state goes `none`; the events consumer already sees the next agent's
  `started` / `ready` lifecycle event, and pokes the hub to reconnect any
  watched conversation.

### 3. The live value and the block: new sub-plugin `jsonl-viewer/plugins/streaming-text`

- `core`: `partialMessage = liveValue("conversations.partial-message",
  { schema, params: ["id"] })`.
- `server`: `serveValue(partialMessage, { source: "external", changes:
  "notified", loader: held state, whileSubscribed: ({ id }, notify) =>
  Runtime.get(row.runtime).watchPartial(id, …), throttleMs: 50 })`. Nobody
  watching ⇒ no socket connection, no cost. At most 20 frames/s per open page,
  each the whole partial (a few KB) — fine; deltas on the wire are not worth a
  keyed value.
- `web`: a `JsonlViewer.TranscriptEnd` contribution. It reads the value and
  `useTranscriptEvents()`, and draws each partial block whose text is not yet
  contained in the window's `assistant-text` event with the same `messageId`.
  A landed message (whose text contains the partial's, being fuller) hides it
  in the same render that draws the finished row. Drawn with the same body
  as a finished message: `assistant-text` exports its body component
  (`Markdown` over `useActiveDataSegments`), without the row actions.
  `loading` draws nothing (no data claim is made: a streaming block that is
  not known yet is simply absent, as the finished row would be).
- Follow-the-bottom: the block grows inside the scroller before
  `bottomSentinel`; verify the stuck-to-bottom scroll follows the growth (and
  only re-asserts follow when the user was at the bottom).

### 4. Remove the `@singularity-host` mark

Delete `agent-launch/core/host-option.ts` and its re-export, the
`set-option … TMUX_HOSTED_BY_OPTION sdk` in `sdk-runtime.ts`
`startAgentSession`, and the mentions in `runtime-sdk/CLAUDE.md` and
`agent-launch/CLAUDE.md` (`plugins-details.md` regenerates). `bin/spike.ts`
keeps its literal: it is the record of the tmux-vs-sdk experiment.

## Measurement: Send → first visible token

One e2e script, `streaming-text/e2e/first-token.ts`: in a scratch
conversation on Haiku, send prompts asking for a ~300-word answer, and in the
page record (MutationObserver, `performance.now()`) from the Send click to
(a) the first streamed character drawn, (b) the finished `assistant-text` row
drawn. (b) is exactly what the page showed first before this change, so one run
gives before and after side by side; 5 interleaved turns × 2 fresh
conversations, p50/p90. Also logged per turn: the SDK's `ttft_ms` (model side),
to split model latency from our delivery (agent → socket → backend → WS →
render). Plus a check with streaming off (no subscriber) that (b) is unchanged.

## Verification

- `./singularity test` on runtime-sdk (fold of stream events into
  `PartialMessage`: deltas, new message, interrupt, error result; frames
  round-trip through the protocol schema) and on the web reconcile (block hidden
  once landed; multi-block message; no matching row).
- Live, on this worktree's build: a long answer streams in; Stop mid-stream
  clears it; a backend restart mid-message loses only the partial and the
  finished message still arrives; a conversation whose agent predates the build
  (no `stream` capability) still works, without streaming; two tabs on one
  conversation share one agent connection; closing the page closes it.
- `rg '@singularity-host|TMUX_HOSTED_BY_OPTION' plugins` → only `bin/spike.ts`.
- Results go into the Phase 2 sub-page and the track header; file the next main
  task (tmux removal) afterwards.

## Files

- `plugins/conversations/plugins/runtime-sdk/bin/agent.ts`, `core/protocol.ts`,
  `machine/internal/{socket-client,sdk-runtime,consumer}.ts`, new
  `machine/internal/partial-stream.ts`
- `plugins/conversations/server/internal/runtime.ts` (`watchPartial`)
- new `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/streaming-text/{core,server,web,e2e}`
- `jsonl-viewer/plugins/assistant-text/web` (export the body)
- `plugins/conversations/plugins/agent-launch/core/{host-option,index}.ts`, the two CLAUDE.md files

## Result (2026-10-20)

Built as designed, with these differences:

- **Where the pieces live.** No new sub-plugin. The value
  (`conversations.partial-message`, `PartialMessage`) is in `conversations/core`
  and served by `conversations/server` (`partial-message.ts`) through
  `Runtime.get(row.runtime).watchPartial`. The block is in `assistant-text`
  (`StreamingText`, a `JsonlViewer.TranscriptEnd` contribution), drawn by the
  same `AssistantTextBody` a finished row uses. In a demo scope the value is
  answered `null` (`conversations/web`, `Demo.Resource`): no agent runs there.
- **The wire restates the shape.** `runtime-sdk/core/partial.ts` defines its own
  `PartialMessage` schema rather than importing `conversations/core`: the agent
  loads that barrel, and the conversations barrel would add its whole closure to
  every agent's cold start. tsc holds the two together where the machine half
  hands one to the other. `partialFrameOf` takes the SDK's own
  `SDKPartialAssistantMessage`, and its switch names every event kind, so an SDK
  upgrade that changes the stream fails the build.
- **The serve declares a read.** Finding the conversation's runtime reads its
  row, so the value declares `reads: { tables: [conversations] }`
  (`no-db-backed-notify`). The loader itself only reads memory.
- **Replies in command order.** The first live run crash-looped the backend:
  the agent answered `subscribe` synchronously but `hello` asynchronously, so
  the backend took the hello reply for the snapshot, and its parse threw inside
  a socket callback. Now every connection answers its commands strictly in
  order (a per-connection promise chain). A stream that breaks (a line that
  does not parse, a frame that does not apply) closes that subscription and
  files a `SdkPartialStreamBroken` report. It never throws from a socket
  callback.
- **Not measured: `ttft_ms`.** Stream events are no longer written anywhere, so
  the model-side time is not logged per turn. The page-side split below is what
  the reader sees.

**Send → first visible text**, in the page (`assistant-text/e2e/first-token.ts`):
Haiku, ~300-word replies, 2 fresh conversations × 5 turns, this worktree's
build, the machine also running other builds:

| Shown first | p50 | p90 |
| --- | --- | --- |
| Before: the finished message's row | 7.07 s | 8.09 s |
| After: the first streamed text | 1.83 s | 2.92 s |

10/10 turns streamed before their row landed. The row time is the same
measure the page showed first before this change, taken on the same turns.
Stop mid-stream clears the block (checked by the same script).
A backend restart mid-message was not exercised live: the hub starts from the
agent's snapshot on (re)subscribe, so only the text the page had not yet drawn
is affected.
