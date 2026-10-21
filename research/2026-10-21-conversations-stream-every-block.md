# Stream every content block (thinking, text, tool calls) as stand-in rows

Follows `research/2026-10-20-conversations-token-streaming.md` (text-only token
streaming, on main).

## Context

Today only the reply's **text** streams: `partialFrameOf`
(`runtime-sdk/core/partial.ts`) keeps `text_delta` and drops thinking and tool
input. The page draws that text in `JsonlViewer.TranscriptEnd`
(`assistant-text/web/components/streaming-text.tsx`), below every transcript
row. A thinking block (and any tool call of the same message) only appears
when its JSONL line lands, as a row ABOVE the already-streamed text — the user
sees text, then the Thinking card popping in on top of it. Thinking is
invisible while it is written (only the working dots), and a tool call shows
nothing until its whole input is generated (a long `Write` / `Edit` takes
seconds).

Goal: stream every block of the in-flight message, draw each through the
renderer its real row will use, in block order, and drop each stand-in in the
render its real row lands. The JSONL stays the only truth: the stand-ins are
transient; what remains is always the transcript.

## Design

### 1. Wire: typed partial blocks (`runtime-sdk/core/partial.ts`, `conversations/core/partial-message.ts`)

`PartialBlock` becomes a union (both files restate it; the machine half's
contract keeps tsc holding them together, as today):

```ts
| { kind: "text";     index; text }
| { kind: "thinking"; index; text }
| { kind: "tool_use"; index; toolUseId; name; inputJson }
```

Frames:

- `start { messageId }`, `clear` — unchanged.
- **new** `open { index, block: { kind: "thinking" } | { kind: "tool_use", toolUseId, name } }`
  from `content_block_start`.
- `delta { index, text }` — unchanged shape; appends to the block's `text` or
  `inputJson`. A delta for an index never opened is a **text** block: text
  blocks need no `open` (old agents never send one — agents outlive deploys and
  `PROTOCOL_VERSION` stays), and `content_block_start` of a text block with
  initial text stays a delta.
- `partialFrameOf`: `thinking_delta` → delta(thinking), `input_json_delta` →
  delta(partial_json); `content_block_start` thinking/tool_use → `open`;
  `redacted_thinking`, `server_tool_use`, `signature_delta`, `citations_delta`
  → null, each **named** in the switch (an SDK upgrade adding a kind is a
  decision there).
- Snapshot compatibility: an old agent's `subscribe` reply holds blocks without
  `kind` → the snapshot schema defaults a kind-less block to `text`.

### 2. Partial JSON: new `packages/partial-json` (core)

`parsePartialJson(prefix: string): unknown` — the value of the longest prefix
that is complete by construction: cuts back to the last point where every open
container can be closed (after `{`/`[`, after a finished value), finishing an
in-progress **value** string (dangling escape dropped); an in-progress key,
number or literal is cut. `undefined` only for an empty prefix. `JSON.parse` of
the built candidate cannot fail on a valid stream prefix — if it does, it
throws (a broken stream is loud). Pure, `*.test.ts` beside it.

### 3. Web: the stand-ins (jsonl-viewer web)

- **`useStreamingBlocks(conversationId, events)`** (jsonl-viewer web,
  `streaming-blocks.ts`, pure core `unlandedBlocks` moved here from
  assistant-text and generalised): the partial message's blocks the transcript
  does not hold yet, each as a stand-in `JsonlEvent` keyed
  `${messageId}:${index}`, in index order:
  - text → `assistant-text` (`messageId`, text); landed when the message's
    merged `assistant-text` contains it (today's rule); an empty text block is
    not drawn (today's rule).
  - thinking → `assistant-thinking`; landed when the message has at least as
    many `assistant-thinking` events as this block's ordinal among its thinking
    blocks.
  - tool_use → `tool-call` (`toolUseId`, `name`, `input: parsePartialJson(inputJson)`,
    no result); landed when a `tool-call` with that `toolUseId` is in the window.
  - **Order rule**: a block is also landed once any LATER block of the message
    landed (the CLI writes a message's lines in block order), so a stand-in can
    never sit below a row that follows it.
  - Returns `{ events, writing }` — `writing`: the last stand-in is text.
- **`StreamingMessage`** (jsonl-viewer web component), rendered by `JsonlPane`
  just before the `TranscriptEnd` contributions: each stand-in through
  `<EventRow event standIn />` (the echo-row precedent: the same renderer, no
  identity, inert) inside `<StreamingRowProvider>`, wrapped in today's
  `EasedHeight` + `data-streaming-message` (moved from streaming-text, so
  `assistant-text/e2e/first-token.ts` still finds it). `loading` / `unavailable`
  draw nothing, `error` draws `ResourceErrorInline` (today's behaviour).
- **`useStreamingRow(): boolean`** exported from jsonl-viewer web — the row is
  a stand-in for a block still being written. Renderers that draw a growing
  block differently read it:
  - `assistant-text`: streaming → today's `StreamingBlock` (steady reveal);
    `StreamingText` and its `TranscriptEnd` contribution are deleted.
  - `tool-call`'s `ToolCallRow`: streaming and the matched renderer does not
    declare `partialInput` (new `JsonlViewerTool.Renderer` meta, read with
    `useMatch`) → a header-only `ToolCallCard` (badge + name), never a renderer
    that may require a field the input does not have yet (`AgentToolView`
    `.parse`s its input). `Bash`, `Edit`, `Write` declare `partialInput: true`
    (they already default every field).
  - `assistant-thinking`: unchanged card (collapsed, as its row lands).
- `landsShown: true` on the `assistant-thinking` and `tool-call` renderers: the
  stand-in already drew them, so the real row takes its place at rest.
- `TranscriptActivity`: `workingActivityOf([...events, ...standIns], writing)` —
  "Thinking" while thinking streams, the tool's label while its call is
  written, "Writing" only while text streams. (Fixes today's "Writing" shown
  for as long as a finished partial is held.)

### Cost

Each push stays the whole message (50 ms throttle): a 30 KB `Write` input is
≤ 600 KB/s to an open page on localhost, and one partial-JSON parse per push.
Acceptable; a keyed per-block value is the follow-up if it shows in profiles.

## Files

- `plugins/conversations/plugins/runtime-sdk/core/partial.ts` (+ `partial.test.ts`)
- `plugins/conversations/core/partial-message.ts`
- new `plugins/packages/plugins/partial-json/core/{index.ts,partial-json.ts,partial-json.test.ts}`
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/`:
  new `streaming-blocks.ts` (+ test), `components/streaming-message.tsx`,
  `components/streaming-row-context.tsx`; `components/jsonl-pane.tsx`,
  `working-activity.ts`, `index.ts`
- `jsonl-viewer/plugins/assistant-text/web/` (index, assistant-text-row, delete
  streaming-text.tsx + unlanded-blocks.ts; keep the reveal internals)
- `jsonl-viewer/plugins/assistant-thinking/web/index.ts`
- `jsonl-viewer/plugins/tool-call/web/{slots.ts,index.ts,components/tool-call-row.tsx}`;
  `tool-call/plugins/{bash,edit,write}/web/index.ts`

## Verification

- `./singularity test` on `runtime-sdk`, `packages/partial-json`, `jsonl-viewer`
  (fold: open/delta per kind, legacy kind-less delta & snapshot; partial JSON:
  every prefix of real tool inputs parses, never throws; stand-ins: landing per
  kind, order rule, empty text).
- `./singularity build`, then live in this worktree: a turn that thinks, writes
  and calls `Write` — Thinking card appears first and stays above, text streams
  below it, the Write card appears while its content is generated and grows;
  each swaps for its real row with no jump. Stop mid-stream clears the
  stand-ins. `assistant-text/e2e/first-token.ts` still passes.
