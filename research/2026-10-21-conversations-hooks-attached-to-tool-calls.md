# Hooks attached to the tool call they ran on

Mockup: proto-1792553875-e62mi3 (direction `attached`, `quiet: count`, `repeats: grouped`).

## Context

Every Claude Code hook record in a transcript (`type: "attachment"`, `attachment.type: hook_*`) carries the `toolUseID` of the call it ran on. The parser (`buildJsonlEvents`) ignores it and emits each record as a standalone `attachment` event. The viewer therefore draws them as loose cards, away from the call:

- In conv-1792552565-pmoec1, 13 identical red "Hook stopped the agent · PreToolUse:Bash" cards follow 13 blocked `echo` calls. Each card repeats the long guard message, and none says which call it stopped.
- Passing hooks (`hook_success`, 451 in one transcript) are each a card of their own.

The intended outcome:

- A hook's outcome renders on its tool card. A PreToolUse block reads "Blocked before running", and its reason sits in place of the result.
- Errors and added context attach to the call as tinted bands.
- Passing hooks fold into a shield and count in the card header.
- Consecutive calls blocked for the same reason collapse into one card.

## Design

### 1. Data: hooks become part of the tool-call event (server, `transcript-source`)

This is the same pattern as `result`, and as `injectedContext` (`parse-jsonl.ts:424-435`), which already folds lines linked by `sourceToolUseID` into their call.

- **`core/protocol.ts`:** add `HookRecordSchema`, and add `hooks: z.array(HookRecordSchema).optional()` to the `tool-call` variant. The fields are:
  - `at`
  - `event` (the `hookEvent`, e.g. `PreToolUse`)
  - `name` (the `hookName`, e.g. `PreToolUse:Bash`)
  - `outcome`: `"pass" | "context" | "message" | "error" | "block" | "cancelled"`
  - `text?` (the message, joined context, or system message)
  - `command?`, `exitCode?`, `durationMs?`, `stdout?`, `stderr?`
- **`server/internal/parse-jsonl.ts`:** a pure `hookRecordOf(subtype, att, at)` maps the subtypes to outcomes. It returns `undefined` for a subtype it does not know.

  | subtype | outcome |
  |---|---|
  | `hook_success` | `pass`, or `error` when `exitCode ≠ 0` or `stderr` is non-empty |
  | `hook_additional_context` | `context`; `text` is `content.join("\n\n")` |
  | `hook_system_message` | `message` |
  | `hook_non_blocking_error` | `error` |
  | `hook_blocking_error`, `hook_stopped_continuation` | `block` |
  | `hook_cancelled` | `cancelled` |

- **Attachment branch (around line 657):** if the subtype maps, the record has a `toolUseID`, and `toolCallByUseId` has that call, push the record onto `call.hooks` and `continue`.
  - Otherwise, keep the standalone `attachment` event as today. That covers SessionStart, UserPromptSubmit and Stop hooks, unknown subtypes and orphan ids, so nothing is dropped silently.
  - In real transcripts the call always precedes its hooks. Pre-hooks land between the call and its result; a blocking record trails the result. So a single pass is enough and no deferred queue is needed.
- **What moves with it:**
  - A tool call's row id (`tool:<id>`) is unchanged, and a hook landing later is an upsert of its call, the same path a result takes.
  - The `s<seq>` ids of later rows shift once for existing conversations, because fewer rows are emitted. This is acceptable: the stream stays append-only.
  - No consumer outside the four hook renderers reads `hook_*` subtypes. I checked working-activity, outline, stats, context-runs, agent-thread and reports.

### 2. Rendering on the card (`jsonl-viewer/plugins/tool-call`)

All tool renderers draw through `ToolCallCard` → `ToolCallFrame` → `CollapsibleCard`, so one change reaches every tool.

- **`collapsible-card`:** a new `band?: ReactNode` prop, rendered always visible between the header `Line` and the `FoldMotion` body. It is shown even while the card is closed.
- **`ToolCallFrame`:** a new `hooks?: HookRecord[]` prop. `ToolCallCard` passes `event.hooks`.
  - **Band:** a new `HookBand` component (`tool-call/web/components/hook-band.tsx`) shows each loud hook (any outcome but `pass`) in event order. Its tone is `destructive` for `block`, `warning` for `error` and `cancelled`, and `info` for `context` and `message`. Each entry has:
    - an icon (`shield`)
    - the title ("Blocked before running" / "Hook failed" / "Added context" / "Hook message")
    - the muted suffix `· <hook> · <event>`
    - the summary line
    - a "Details" disclosure showing the command, exit code, duration, stderr and the full text
  - **Quiet passes:** a shield and count in the header, composed into `trailing` next to `BouncingDots`. `WithTooltip` lists `name · event · duration`.
  - **Blocked:** a `block` from a `PreToolUse` hook gives the note `· did not run`. The body, which repeats the block text as the result, stays collapsed by default.
- **Summary line:** a guard denial is `withRefusalBanner`'s format (`framework/tooling/guards/core/refusal.ts`).
  - The guards plugin exports the inverse, `refusalReason(text): string | undefined` (the part after `Why it was blocked:`), from a module that does not pull `parseShell`. The format is then parsed by its owner and nowhere else. A `refusal.test.ts` round-trip pins it.
  - Any other hook's summary is the first paragraph of `text` (or of `stderr`), clamped to 3 lines.
  - If `./singularity check boundary-rules` forbids `web` from reaching `guards/core`, move the format into its own small `core` plugin that both import.

### 3. Grouping repeated blocks — DROPPED after review

Built, then removed at the user's request: one card for N blocked calls hid each call's own card (its input and result), and the reader wants every call visible. Each blocked call is its own card with its own band. What was built, for the record:

This follows the precedent of `groupContextRuns` (`web/context-runs.ts`), and stays generic so the viewer never names the tool-call plugin.

- **New slot `JsonlViewer.EventRun`:** contributions have the shape `{ id, key(event) => string | undefined, component: ComponentType<{ events: JsonlEvent[] }> }`.
- **Pure `groupEventRuns(items, events, runs)`** in `web/event-runs.ts`, run after `groupContextRuns` in `use-context-runs.ts`. It merges 2 or more consecutive plain `{kind:"event"}` items (not hosting context) whose events get the same non-undefined key from the same contributor into a new `TranscriptItem` `{ kind: "run", contributor, indices }`.
- **`transcript-view.tsx` `renderItem`:** draws a run as `RowEnter > div[data-event-key=<first member>] > <component events>`, the same frame a fold gets.
- **`tool-call` contribution:** `key` is `${name}|${hook.name}|${text}` for a call blocked by a PreToolUse hook, and `undefined` otherwise. Its `BlockedRunCard` reuses `ToolCallFrame` with:
  - the tool badge, then `×N`
  - the note `· none ran`
  - one `HookBand`, followed by the inputs as struck-through mono chips, using each tool's existing summary of its input via the event's `input`. For Bash that is `command`, falling back to a JSON one-liner.

### Out of scope (follow-ups)

These stay as today's standalone cards:

- Hooks without a tool call: UserPromptSubmit (the mockup's centred divider under the prompt), Stop (the mockup's "Turn not ended" card) and SessionStart (already folded into Session context). They can reuse `HookRecord` and `HookBand` in a second step.

## Files

- `plugins/conversations/plugins/transcript-source/core/protocol.ts`: `HookRecordSchema`, `hooks` on tool-call
- `plugins/conversations/plugins/transcript-source/server/internal/parse-jsonl.ts`: `hookRecordOf`, pairing
- `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx`: `band`
- `.../jsonl-viewer/plugins/tool-call/web/components/{tool-call-card.tsx, hook-band.tsx, blocked-run-card.tsx}`, `web/index.ts` (EventRun contribution)
- `.../jsonl-viewer/web/{slots.ts, event-runs.ts, use-context-runs.ts, context-runs.ts (TranscriptItem), components/transcript-view.tsx}`
- `plugins/framework/plugins/tooling/plugins/guards/core/refusal.ts` (or a split-out module): `refusalReason`

## Verification

- **Tests** (`./singularity test <path>`):
  - `transcript-source/server/internal/parse-jsonl.test.ts`:
    - Each subtype maps to its outcome.
    - A pre-hook between the call and its result, and a block after the result, both land on the call.
    - An unknown id or subtype stays a standalone attachment.
    - A SessionStart hook stays standalone.
  - Update `transcript-watcher/server/internal/parse-jsonl.test.ts:175-179`, which expects standalone hook events.
  - `jsonl-viewer/web/event-runs.test.ts`:
    - A run needs 2 or more members.
    - It breaks on a different key, on another contributor, and on a hosted item.
  - `guards/core/refusal.test.ts`: `refusalReason(withRefusalBanner(…)) === reason`.
- **Build:** `./singularity build`, then `screenshot.ts --path /agents/c/conv-1792552565-pmoec1`.
  - The 13 blocked `echo` calls should appear as one "Bash ×13 · none ran" card with the wait-loop reason.
  - The Edit call with `hook_additional_context` should show a blue band.
  - Passing hooks should show as a shield and count.
  - No hook cards should remain loose after tool calls.
