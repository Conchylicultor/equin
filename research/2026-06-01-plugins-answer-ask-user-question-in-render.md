# Answer pending AskUserQuestion prompts directly in the JSONL render

## Context

When an agent calls `AskUserQuestion`, the Claude CLI blocks in an interactive
TUI menu inside its tmux pane. Singularity surfaces this state as
`conversation.waitingFor === "question"` and shows a banner — *"Content pending
in terminal — waiting for your input"* (`jsonl-pane.tsx:80`). Today the only way
to answer is to open the terminal pane and drive the TUI by hand.

The pending `AskUserQuestion` is **already rendered** in the JSONL viewer by
`AskUserQuestionToolView`, but read-only: it parses the result string after the
fact to highlight the chosen option. We want to make that render **interactive**
while the question is live — let the user pick answers (single-select,
multi-select, freeform "Other", across all questions) and submit, without ever
opening the terminal.

**Chosen approach (decided with the user):** do **not** drive the TUI menu with
simulated arrow keys (fragile against a black-box TUI). Instead **exit the
question form** (send `Escape`, which returns the CLI to its idle input prompt)
and **send a normal turn** containing the answers serialized as text. This
reuses two battle-tested runtime primitives and adds zero TUI-navigation logic.

## Approach

Make the existing `ask-user-question` renderer plugin gain a small server
surface (one endpoint) and an interactive mode in its web component. The plugin
becomes self-contained: it owns the endpoint, the orchestration, and the UI.

### Reused primitives (no new runtime logic)

- `interruptConversation(id)` — `@plugins/conversations/server`
  → `tmuxRuntime.interrupt()` sends a single `Escape` to the pane
  (`tmux-runtime.ts:297`). This is the "exit the form" step.
- `sendTurn(id, text)` — `@plugins/conversations/server`
  → `tmuxRuntime.send()` does `copy-mode -q` → `C-c` (clear line) →
  bracketed-paste → `Enter` (`tmux-runtime.ts:311`). This is the
  "send a new prompt" step.
- `defineEndpoint` / `implement` / `useEndpointMutation`
  (`@plugins/infra/plugins/endpoints/{core,server,web}`).
- `conversationPane.useParams()` → `{ convId }`; `useConversationById(convId)`
  → `{ status, waitingFor, ... }`; `useResource(jsonlEventsResource, {id})` →
  ordered `JsonlEvent[]` (to detect the last tool-call).

## Step 1 — Live behavior verification (do this FIRST, before coding)

The whole approach hinges on one unverified assumption: **`Escape` on a pending
`AskUserQuestion` cancels the form and leaves the CLI at an idle input prompt
that immediately accepts a pasted turn.** There is a known CLI quirk here — the
pane keeps the spinner glyph + `status:"busy"` during `AskUserQuestion` even
though it is idle (that's why the runtime *probes* for `"Enter to select"` to
set `waitingFor:"question"`, `tmux-runtime.ts:18-41`).

Verify manually against a live session:

1. Get a conversation into the `waitingFor:"question"` state (ask an agent a
   question, or run a prompt that triggers `AskUserQuestion`).
2. `tmux capture-pane -p -t <conv-id>` — confirm the menu + `"Enter to select"`.
3. `tmux send-keys -t <conv-id> Escape` — re-capture. Confirm the menu is gone
   and the normal Claude input box is shown.
4. Run the `sendTurn` sequence (`copy-mode -q` → `C-c` → `load-buffer` →
   `paste-buffer -d -p` → `send-keys Enter`) with a test answer and confirm the
   agent receives it as a normal user turn and resumes.

**Outcome determines the settle logic** between interrupt and send:

- If Escape → instantly idle: handler is just `interrupt` then `sendTurn`, no wait.
- If a brief transition is observed: add a **bounded** settle (re-`capture-pane`
  until the idle input box is present, cap ~3s, with a hard fallback) inside the
  handler. This is a one-shot orchestration wait, not a recurring poller, so it
  does not violate the no-polling rule — but prefer no wait if step 3 shows none
  is needed.

If Escape behaves differently than assumed (e.g. it resumes the agent into a
"working" state, or needs a different key), STOP and revise this plan rather
than working around it.

## Files

### New (mirror the `exit` plugin precedent)

Plugin root:
`plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/tool-call/plugins/ask-user-question/`

- `shared/endpoints.ts`
  ```ts
  import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
  import { z } from "zod";
  export const AnswerAskUserQuestionBodySchema = z.object({ text: z.string().min(1) });
  export const answerAskUserQuestion = defineEndpoint({
    route: "POST /api/conversations/:id/answer-question",
    body: AnswerAskUserQuestionBodySchema,
  });
  ```
- `shared/index.ts` — `export { answerAskUserQuestion, AnswerAskUserQuestionBodySchema } from "./endpoints";`
- `server/index.ts`
  ```ts
  import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
  import { answerAskUserQuestion } from "../shared/endpoints";
  import { handleAnswer } from "./internal/handle-answer";
  export default {
    id: "conversation-jsonl-viewer-tool-call-ask-user-question",
    name: "AskUserQuestion answer",
    httpRoutes: { [answerAskUserQuestion.route]: handleAnswer },
  } satisfies ServerPluginDefinition;
  ```
- `server/internal/handle-answer.ts`
  ```ts
  import { implement } from "@plugins/infra/plugins/endpoints/server";
  import { interruptConversation, sendTurn } from "@plugins/conversations/server";
  import { answerAskUserQuestion } from "../../shared/endpoints";
  export const handleAnswer = implement(answerAskUserQuestion, async ({ params, body }) => {
    await interruptConversation(params.id);   // Escape — exit the form
    // settle here only if Step 1 proves it necessary (bounded, capture-pane based)
    await sendTurn(params.id, body.text);     // C-c → paste → Enter
    return { ok: true };
  });
  ```
- `web/components/answer-form.tsx` — interactive controls (below).
- `package.json` — add `server` + `shared` barrels (mirror
  `exit/package.json`; depends on `@plugins/conversations`,
  `@plugins/infra`, `zod`).

> Registration is automatic: `./equin build` regenerates
> `web.generated.ts` / `server.generated.ts` by discovery. The
> `plugins-registry-in-sync` check enforces it. No manual registry edits.

### Modified

- `web/components/ask-user-question-tool-view.tsx` — add interactive mode.
- `web/index.ts` — unchanged (still only contributes the web renderer).
- `CLAUDE.md` — regenerated by build; add prose describing interactive mode.

## Web: interactive mode

In `AskUserQuestionToolView`:

1. `const { convId } = conversationPane.useParams();`
   `const conversation = useConversationById(convId);`
   `const { data: events } = useResource(jsonlEventsResource, { id: convId });`
2. Compute `isLive`:
   ```ts
   const lastToolCall = events?.findLast((e) => e.kind === "tool-call");
   const isLive =
     event.result == null &&
     conversation?.waitingFor === "question" &&
     lastToolCall?.toolUseId === event.toolUseId;
   ```
   The `lastToolCall` check matters: if Escape leaves the old tool_use orphaned
   (no result ever written to JSONL), it prevents a stale prior question from
   re-showing interactive controls.
3. When `!isLive` → render exactly today's read-only view (unchanged).
4. When `isLive` → render `<AnswerForm questions={questions} convId={convId} />`
   inside the same `ToolCallCard` (`defaultOpen`).

`AnswerForm` (full parity):

- Local state per question: a `Set<string>` of selected option labels + an
  `otherText` string.
- **Single-select** (`!multiSelect`): clicking an option row sets the selection
  to just that label (and clears `otherText`); reuse the existing radio
  `Indicator`. Typing in the "Other" field selects freeform (clears option
  selection).
- **Multi-select**: clicking a row toggles the label in the set; "Other" text is
  additive; reuse the checkbox `Indicator`.
- **Other**: every question gets a freeform text input row (the tool always
  allows "Other").
- Reuse the current option-row layout/visuals — only difference is rows become
  clickable and there's a freeform input + Submit button.
- Submit enabled only when **every** question has an answer (≥1 selected label
  or non-empty `otherText`).
- Serialize to text (web-only helper), e.g.:
  ```
  Answering your questions:

  - <header1>: <labels joined ", "[, <otherText>]>
  - <header2>: ...
  ```
  Use option **labels** (the chosen values), append freeform text if present.
- Fire `useEndpointMutation(answerAskUserQuestion)`:
  `mutate({ params: { id: convId }, body: { text } })`. Show a pending state on
  Submit; on success the controls disappear naturally as `waitingFor` clears and
  the new user turn streams in below. Surface errors via `notifications.toast`
  (do not swallow).

## Verification (end-to-end)

1. **Step 1 live verification above** — gates everything.
2. `./equin build`, then open `http://<worktree>.localhost:9000`.
3. Drive a conversation into `waitingFor:"question"`. Confirm the
   `AskUserQuestion` render now shows clickable options + an "Other" field +
   Submit (no terminal needed). Use `e2e/screenshot.mjs` with `--click` to
   verify before/after, or a scripted Playwright run.
4. Submit a single-select answer → confirm a new user turn appears with the
   serialized answers and the agent resumes. Repeat for multi-select, freeform
   "Other", and a multi-question prompt (full parity).
5. Open a **historical, already-answered** `AskUserQuestion` → confirm it still
   renders read-only exactly as before (no interactive controls).
6. `./equin check` (boundaries, registry-in-sync, eslint, docs-in-sync).

## Risks / open questions

- **Escape semantics (Step 1)** — the load-bearing assumption; verified first.
- **Settle timing** — keep the handler as `interrupt → sendTurn` unless Step 1
  proves a bounded wait is needed; never an unbounded/looping poller.
- **Orphaned tool_use** — if Escape writes no tool_result, the event's
  `result` stays null forever; the `lastToolCall` guard prevents stale
  re-activation. (If Escape *does* write `[Request interrupted]`, `result`
  becomes non-null and the read-only branch handles it — also fine.)
- **Message fidelity** — the agent sees its question interrupted, then a user
  message with the answers; the explicit "Answering your questions:" preamble
  keeps it unambiguous.

## Implementation status (2026-06-01)

Built and verified (all 27 `./equin check` pass; not pushed):

- ✅ Runtime `answerPrompt(id, text)` — Escape → bounded `capture-pane`
  poll until the menu (`/Enter to select/`) clears (75ms interval, 3s cap,
  throws on timeout) → send. **Step 1 verification proved the no-wait path is
  unsafe** (the still-live menu auto-selects a fabricated answer); the poll
  fixes it. Proven end-to-end: distinctive answers reach the agent verbatim
  with no fabricated selection.
- ✅ Endpoint `POST /api/conversations/:id/answer-question` + handler.
- ✅ Interactive `AnswerForm` (full parity) — renders + submits correctly
  whenever a live tool-call event exists.
- ✅ Probe broadened: AskUserQuestion menus now set `waitingFor:"question"`
  on idle panes too (current CLI presents them idle, not busy).

**Deferred (follow-up `task-1780306084273-369d0w`):** Claude CLI v2.1.159
withholds the AskUserQuestion `tool_use` from the JSONL transcript until the
question is answered, so the renderer has no live event to attach the form to —
the form never appears for a *genuinely pending* question on this CLI (only the
"Content pending in terminal" banner). The plan's premise (*"the pending
AskUserQuestion is already rendered in the JSONL viewer"*) held only on older
CLIs that flushed the tool_use. Surfacing the form while pending needs the
question content from a source available during the pause — a structured CLI
source (preferred) or a `capture-pane` menu parser (fragile). See the task.
```
