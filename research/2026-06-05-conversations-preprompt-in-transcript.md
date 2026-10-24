# Persist preprompts into the JSONL transcript (and render them)

## Context

A conversation's **preprompt** (e.g. the "Auto-implement" snippet, selected per-task) is
currently delivered via the Claude CLI `--append-system-prompt` flag. That flag mutates the
**system prompt**, which Claude Code never records in the session `.jsonl` (the transcript holds
only `user`/`assistant`/`tool` turns + telemetry). Three consequences:

1. **Invisible.** The conversation UI renders from the jsonl, so an operator can't see which
   preprompt an agent was launched with.
2. **Drifts on resume.** Resume/fork re-derives the preprompt from *live* config every time
   (`lifecycle.ts:172`), so editing the snippet retroactively changes what a resumed agent runs
   with — and there's no record of the original.
3. **Lost on plain resume.** `resumeConversation` doesn't re-pass `--append-system-prompt` at all,
   so a resumed gone-conversation silently loses its preprompt from the system prompt.

**Goal:** bake the resolved preprompt into the **first user turn** of the transcript (wrapped in a
distinctive tag), and render it in the conversation view as a collapsible "Instructions" section —
mirroring the existing `<task-notification>` extraction precedent. This makes the preprompt durable,
visible, frozen-at-launch, and replayed verbatim on resume/fork (fixing all three issues at once).

**Tradeoff accepted (per user):** moving the text from the *system* role to a *user* turn changes
model weighting slightly (Claude weights system-role instructions a touch more strongly than a user
turn). The user explicitly chose the in-transcript approach ("concatenate with the first user
message instead"). Considered alternative — keep `--append-system-prompt` and store the text on the
conversation DB row for display — was rejected: it doesn't put the text "in the jsonl", needs new DB
plumbing, and leaves the drift + resume-loss bugs unfixed.

## Approach

Single shared tag, injected server-side at fresh launch, lifted out parser-side, rendered by a new
sub-plugin. Mirror the `<task-notification>` path byte-for-byte.

### 1. Shared tag + wrap helper (single source of truth)

The injector and the extractor must agree on the exact tag, forever — a drift silently breaks
extraction. Put both in the protocol owner so neither side hard-codes a string.

**`plugins/conversations/plugins/transcript-watcher/core/protocol.ts`** (or a sibling
`preprompt-tag.ts` in `core/`, re-exported from the `core` barrel):

```ts
// Wire tag the agent actually reads in its first user turn. Named
// `special_instructions` (not `preprompt`) so the model reads it as an
// imperative it must follow, not opaque jargon. The internal event kind stays
// `preprompt` (the domain/plugin concept); the UI label is "Instructions".
export const PREPROMPT_TAG = "special_instructions";
const RE = new RegExp(`<${PREPROMPT_TAG}>([\\s\\S]*?)</${PREPROMPT_TAG}>`, "g");

/** Wrap preprompt text for prepending to the first user turn. */
export function wrapPreprompt(text: string): string {
  return `<${PREPROMPT_TAG}>\n${text}\n</${PREPROMPT_TAG}>`;
}

/** Lift the preprompt block out of `text`. Returns the inner text (or null) + the remainder. */
export function extractPreprompt(text: string): { preprompt: string | null; rest: string } { … }
```

Three names, one per layer (intentional): wire tag `special_instructions` (what the agent sees) →
event kind `preprompt` (internal protocol discriminant, matches the plugin) → UI label "Instructions"
(human-facing).

Also add the new event kind to `JsonlEventSchema` (same file), slotting beside `task-notification`:

```ts
z.object({ kind: z.literal("preprompt"), at: z.string(), text: z.string() }),
```

### 2. Inject at fresh launch — `plugins/conversations/server/internal/lifecycle.ts`

Today (≈172–183): resolves `appendSystemPrompt` and passes it to `runtime.create`. Change to:

- Resolve the preprompt text exactly as now (`resolvePreprompt(getTaskPreprompt(...))`).
- **Only when `!resumeSessionId`** (fresh launch, not fork/resume — a forked/resumed transcript
  already contains the baked first turn), prepend the wrapped block to `resolvedPrompt`:
  ```ts
  if (preprompt && !resumeSessionId) {
    resolvedPrompt = resolvedPrompt
      ? `${wrapPreprompt(preprompt)}\n\n${resolvedPrompt}`
      : wrapPreprompt(preprompt);
  }
  ```
  (The `resolvedPrompt`-absent branch covers the **no-initial-prompt edge case**: the first user
  turn becomes the preprompt block alone. Rare — preprompts are per-task and task launches always
  carry a prompt — and harmless: the agent receives its instructions and proceeds. Single code path,
  no hybrid fallback.)
- Stop passing `appendSystemPrompt` to `runtime.create`.

Gating on `!resumeSessionId` is the load-bearing correctness rule: it prevents double-injection on
fork-session (`claude --resume --fork-session` copies the original transcript, preprompt and all).

### 3. Extract in the parser — `…/transcript-watcher/server/internal/parse-jsonl.ts`

Mirror `extractTaskNotifications` (lines 23–76 + call sites 259–286), but gate to the **first** user
message (the only one that can carry the tag):

- Add `let seenPreprompt = false;` before the parse loop.
- In the `type === "user"` branch, before `extractTaskNotifications`, if `!seenPreprompt`, run
  `extractPreprompt(text)`. If a block is found: `seenPreprompt = true`,
  `events.push({ kind: "preprompt", at: ts, text: inner })`, and continue with `rest` as the text
  fed onward (still through `extractTaskNotifications` then `pushTextWithImages`). Emit no user-text
  event if `rest` is empty (same `if (remaining.length > 0)` guard the notification path uses).
- Applies to both the string-content and array-`text`-block paths.

### 4. Render — new sub-plugin (mirror `task-notification`)

`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/preprompt/`

- `web/index.ts` — barrel contributing
  `JsonlViewer.EventRenderer({ match: "preprompt", component: PrepromptRow })`.
- `web/components/preprompt-row.tsx` — collapsible card, **default collapsed** (boilerplate the
  operator rarely needs), using `useCollapsible` + `CollapsibleChevron` from
  `@plugins/primitives/plugins/collapsible/web` exactly as `assistant-thinking-row.tsx` does. Label
  "Instructions" (with a system/launch accent so it reads distinct from a thinking block); body is
  `whitespace-pre-wrap` text. Type the event inline via
  `Extract<JsonlEvent, { kind: "preprompt" }>`.
- Register the new plugin in `web/src/plugins.ts` (the only place default-export plugin imports are
  allowed).

### 5. Cleanup — remove the now-dead `appendSystemPrompt` param

- `plugins/conversations/server/internal/runtime.ts` — drop `appendSystemPrompt` from the
  `ConversationRuntime.create` opts (lines 35–36).
- `plugins/conversations/plugins/runtime-tmux/server/internal/tmux-runtime.ts` — remove the
  `appendSys` block (≈627–639) and the param from the opts type (≈600–605).
- `plugins/conversations/plugins/runtime-api/**` — drop the param from the stub if present.
- Update the `preprompts` plugin description/CLAUDE.md prose: it no longer uses
  `--append-system-prompt`; it now prepends a `<preprompt>` block to the first user turn.

## Critical files

| File | Change |
| --- | --- |
| `…/transcript-watcher/core/protocol.ts` (+ barrel) | New `preprompt` event kind; `PREPROMPT_TAG`, `wrapPreprompt`, `extractPreprompt` shared helpers |
| `conversations/server/internal/lifecycle.ts` | Prepend wrapped preprompt to first turn on fresh launch; stop passing `appendSystemPrompt` |
| `…/transcript-watcher/server/internal/parse-jsonl.ts` | First-user-message `extractPreprompt`, emit `preprompt` event |
| `…/jsonl-viewer/plugins/preprompt/web/{index.ts,components/preprompt-row.tsx}` | New render sub-plugin |
| `web/src/plugins.ts` | Register new sub-plugin |
| `conversations/server/internal/runtime.ts`, `…/runtime-tmux/…/tmux-runtime.ts`, `…/runtime-api/**` | Remove dead `appendSystemPrompt` param |
| `…/preprompts/CLAUDE.md` + barrel description | Update prose |

## Reuse (don't reinvent)

- `extractTaskNotifications` + its call sites — the exact extraction/strip/emit shape to copy.
- `JsonlViewer.EventRenderer` dispatch slot (`…/jsonl-viewer/web/slots.ts`) — `match: "<kind>"`.
- `useCollapsible` / `CollapsibleChevron` (`primitives/plugins/collapsible/web`) — as in
  `assistant-thinking-row.tsx`.
- `resolvePreprompt` / `getTaskPreprompt` — preprompt resolution, unchanged.

## Constraints

- **`conversations` is load-bearing → explicit user approval required before implementing.**
- Mirror the `task-notification` precedent byte-for-byte; deviate only where the "first message
  only" + "shared tag constant" semantics require.
- No new DB columns, no polling, fail-loud (a malformed/unclosed tag simply doesn't match → falls
  through as ordinary user text; no swallowed errors).

## Verification (end-to-end)

1. `./equin build`.
2. Ensure a preprompt exists in config and is selected on a task (preprompts settings + task-preprompt
   picker). Launch a fresh conversation under that task.
3. **Transcript:** `query_db` the conversation's `claude_session_id`, open its `.jsonl`, confirm the
   first `user` record's text begins with `<special_instructions>…</special_instructions>` followed
   by the task prompt.
4. **Render:** open `http://<worktree>.localhost:9000/c/<id>` — confirm a collapsed "Instructions"
   card appears above the first user message, expands to the preprompt text, and the raw
   `<special_instructions>` tag is **not** shown in the user message bubble. Use `e2e/screenshot.mjs --click "Instructions"`
   to capture before/after.
5. **No double-render on fork:** use a +Sonnet fork-session button; confirm the forked conversation
   shows exactly one Instructions card (inherited, not re-injected) and the system still behaves.
6. **No-prompt edge:** create a conversation with a preprompt but empty prompt; confirm the first
   turn is the preprompt block alone and the agent starts cleanly.
7. `./equin check` green (migrations/docs/boundaries/eslint).
