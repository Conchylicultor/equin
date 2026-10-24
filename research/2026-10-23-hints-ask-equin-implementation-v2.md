# Ask equin — implementation plan (v2)

Design and decisions: `research/2026-10-23-hints-ask-equin-floating-thread.md`.
Prototype: `proto-1792772741-le95f8` (chrome skin, default bottom-right).
Supersedes `…-implementation.md`, after the user's review:

- **No new `add_task` option.** Filing a task that starts now is a tool only
  the Ask equin profile can see.
- **No hand-written anchor labels.** Show me points at the page's own
  structure, the `ui-context` lineage the element picker already reads.
- **Sonnet by default**, for fast answers, and changeable in config.

## Context

The ? menu's **Ask equin how to…** opens a one-shot launch dialog, and the
answer lands in the Agent Manager queue. This change replaces it with a
**floating, draggable card that holds one threaded conversation**. It is
available on every page and stays open across app switches.

The agent **reads equin's code but cannot change it**. When something needs
doing, it **files a task that launches at once**. Its answers can carry
**Show me** spotlights and `<go>` choices.

## What we reuse

| Need | Existing piece |
|---|---|
| Thread view, composer, Stop, resume, Done | `conversations/agent-thread`: `<AgentThread>`, `EndThreadButton` |
| Start a run under a scratch profile | `useStartThread` (`agent-thread/web/internal/use-start-thread.ts`) |
| Pill progress, unseen dot, restore after reload | `useThreadProgress`, `useThreadRuns(profile, {limit: 1})`. Places' `use-ask.ts` is the pattern. |
| A typed result card in the thread | `defineThreadResult`, an MCP tool reserved to the profile. Places' `placesPicks` + `ask/server/internal/tools.ts` is the pattern. |
| Agent context, tools, permissions | `defineScratchProfile`. Places' `ask/server/internal/profile.ts` is the pattern. |
| The checkout path | `getMainRepoRoot()` (`infra/spawn/core`) |
| Creating and arming a task | `createTask` (`tasks/tasks-core/server`), `armTaskAutoStart` (`tasks/server`), `setTaskCategory`, track |
| What's on the page | `primitives/ui-context`: the `data-lineage` markers (contributions stamped by `element-picker`'s middleware, regions by `<UiRegion>`), `collectMeta(el)`, the element descriptor (`formatElementDescriptor`) and the lineage grammar (`formatLineagePath` / `parseLineagePath`) |
| `<go>` choices | `active-data/plugins/go`. It needs a `PromptComposer`; see step 1. |
| Drag | `useDragGesture` (`primitives/dom/plugins/movable/web`) |
| Position persistence | `defineStore` (`primitives/dom/plugins/web-storage/web`) + `useDraft` (`primitives/persistent-draft/web`) |
| A configurable model | `defineConfig` + `ModelChoiceSchema` (`conversations/model-provider/core`) |
| Mounted once, above every tab | `Core.Root`, like `HintHost` |
| Look | `apps-core/plugins/chrome-theme`: the fixed graphite theme the rail, tab bar and toasts already wear |
| Where the user is | `useActiveApp()` and `usePathname()` (`apps-core/web`) |
| Spotlight | the hints engine's `HintStage` / `StageScene` (`hints/web`) |
| The Help category | `HELP_CATEGORY_ID` (`hints/plugins/help-menu/core`) |

## Steps

### 1. `agent-thread`: answers render like the transcript

This is general and helps Places too.

- **Render active-data blocks.** The answer goes through `useActiveDataSegments`,
  as `assistant-text-row.tsx` already does: block segments become their
  components, and the rest goes to `Markdown`. Wrap the answer in
  `ActiveDataIdentityProvider`, which needs the answer's message id, so
  `groupThread` carries that id on `turn.answer`.
- **Make `<go>` send.** `ThreadComposer` registers
  `useRegisterPromptComposer({ insert, send, canSend })`. `send` goes to the
  existing `sendConversationTurn`, and `insert` goes to the draft. `AgentThread`
  mounts a `PromptComposerProvider`.
- Tests: `groupThread` carries the message id. A jsdom test checks that a
  `<go>` in an answer sends a turn.

### 2. `ui-context`: the page outline, and finding an element again

This goes in the neutral leaf that already owns the grammar.

**`collectOutline(root)`** walks the visible DOM. It keeps:
- every interactive element with an accessible name (button, link, input,
  `role=tab|menuitem|switch|…`), written as its element descriptor
  (`button — Share`);
- grouped under its lineage path: the innermost contribution or region, in
  the existing `@` / `#` grammar.

Each entry is `{ path, element }`, the two fields a `<ui-context>` token
already uses to name an element. The outline is capped (about 150 entries)
and printed in document order, as an indented tree, for example:

```
apps.pages.shell@apps.app > pages/page#pane:page[column 1 of 1]
  pages/share@PaneToolbar.Item
    button — Share
```

**`resolveUiContext({ path, element })`** is the inverse of `collectMeta`. It
finds the live element whose lineage path and descriptor match. It returns a
result type: `found`, `gone` (nothing matches on this page now) or
`ambiguous` (several candidates; it picks the first visible one and says so).

Tests:
- a pure outline over a jsdom tree with stamped markers;
- resolve round-trips `collectMeta` on the same tree.

The contribution markers exist only when `element-picker`'s middleware is in
the composition. The ask plugin imports the `element-picker/web` barrel so its
contribution markers are always present wherever the card is. On a host
without them, the outline is regions only, which is coarse but still valid.

### 3. `hints`: spotlight an element

- `pointAt(target: () => Element | null, { body, onBack, next? })` is a one-step
  spotlight. `HintHost` turns it into a transient `StageScene` drawn by the
  same `HintStage`: hole, caption, Back and Next.
- It tracks the element with the engine's existing `autoUpdate` positioning. No
  declared anchor is needed. A target that resolves to `null` fails loudly to
  the caller, so nothing is spotlit silently wrong.

### 4. `active-data/plugins/show-me`: a new inline tag

- The tag is
  `<show-me path="…" element="button — Share">the Share button</show-me>`, with
  the same two fields as the outline.
- It renders as a small target chip. Clicking it runs `resolveUiContext`, then
  `pointAt`.
  - `gone`: the chip says it isn't on this page.
  - When the `path` names another app (its first region), it offers to go
    there first.
- It works in any conversation, including the full Agent Manager view, and in
  AgentThread thanks to step 1.

### 5. `apps-core/tabs`: the focused tab's title

- Export `useFocusedTabTitle()`, a module signal like the existing
  `focusedApp`. `Core.Root` sits outside `TabsProvider`, so it cannot call
  `useTabs`.

### 6. New plugin `plugins/hints/plugins/ask`

**`core/`**
- `HELP_ASK_PROFILE = "help.ask"`.
- `AskInputSchema`: `{ app, appName, path, title, outline }`.
- The suggestion data: `ALWAYS` (2 questions) and `ROTATE` (3), with a pure
  `pickSuggestions(random)`, tested.
- `askFiledTask = defineThreadResult({ tool: "ask_file_task", schema })`.
- `askConfig = defineConfig({ model: ModelChoice, default "sonnet" })`, shown in
  Settings → Config.

**`server/`**
- **The profile** is registered with
  `ScratchProfile.define(defineScratchProfile({…}))`.
  - **Instructions** come from the current `askHowToPrompt` brief, plus:
    - the checkout path (`getMainRepoRoot()`);
    - the page context and its outline;
    - how to write `<show-me>` from outline entries;
    - offer next steps as `<go>`;
    - anything that needs a change is filed with `ask_file_task`;
    - end the turn and never call `exit_clean`.
  - **Tools** (`mcpTools`): `ask_file_task` and `flag_raise`. No `add_task`.
  - **Permissions**: `allow: Read, Grep, Glob`;
    `deny: Write, Edit, NotebookEdit, Bash`.
- **The `ask_file_task` tool** is reserved with
  `Mcp.tool({ name, profiles: [HELP_ASK_PROFILE] })`, so no other agent ever
  sees it.
  - Its input is `{ title, description }`.
  - It creates a task with no dependency edges, on track `main`, in the
    Improvements category (the one the Improve button files under).
  - It creates the task fresh with the default workspace, a worktree, rather
    than inheriting the help agent's scratch workspace.
  - It arms auto-start with the configured model, which wakes the launcher at
    once because nothing blocks the task.
  - It returns the task id.

**`web/`**
- `HelpMenu.Entry({ id: "ask", … })`, contributed by this plugin. It opens the
  card, and reads "Back to your question" when a thread is minimized.
- `Core.Root({ component: AskHost })`. A module store holds
  `{ mode: closed | open | min, conversationId }`.
  - **Restore after a reload.** Once per load, take back the newest run of
    `useThreadRuns(HELP_ASK_PROFILE, {limit: 1})` as the pill, when it is
    still working or has an unseen answer.
- `AskCard` uses `chrome-theme` and the `z-float` layer, and can be dragged by
  its header.
  - **Position.** A `defineStore` of `{h, hx, v, vy}` (anchored to the nearest
    edges, so the card grows away from the corner).
  - **Snapping.** It snaps only when dropped within about 36px of a corner.
    That rule is a pure `placeAfterDrag`, tested.
  - **The top-right corner** sits below the action bar.
- **Empty state.** The picked suggestions and a first-question composer
  (`TextEditor`). The first send captures the context:
  - `useActiveApp`, `usePathname` and `useFocusedTabTitle`;
  - `collectOutline(document.body)`, excluding the card itself.

  It then calls `useStartThread({ profile: HELP_ASK_PROFILE, categoryId:
  HELP_CATEGORY_ID, model: askConfig.model })`.
- **Thread.** `<AgentThread conversationId results={[askFiledTask]}
  renderResult={FiledTaskCard}>`. `FiledTaskCard` is the live task (`useTask`):
  its title and status, and a click opens it in the Agent Manager.
- **Header.** The question as title, plus:
  - Open in Agent Manager (`conversationRoute` via `navigate`);
  - New question (lets go of the run, which stays in the Agent Manager);
  - Minimize;
  - `EndThreadButton` (Done). Filed tasks have no edge to the help task, so
    dropping it leaves them running.
- **The pill** reads `useThreadProgress`: the step it is on while working, and
  an unseen dot when an answer arrives.

**`help-menu`**: delete `AskEquinEntry`, `openAskDialog` and `askHowToPrompt`
(the brief moves to `ask/server`). Update its index description.

## Known limits (v1)

- **The page context and outline are captured at the first send.** A
  follow-up from another page doesn't tell the agent about the new page.
  - Show me still resolves live, so on the wrong page it says "not on this
    page" rather than spotlighting something wrong.
  - A later fix could resend the context on each turn.
- **The outline sees only what is rendered.** A control inside a closed
  popover or menu is not listed. Show me can point at its opener.
- **The step list is AgentThread's own look**, not the prototype's "N steps"
  fold. Restyling it is a later polish pass.

## Verification

- **Tests**, one plugin at a time (`./singularity test <plugin>`):
  - `agent-thread`: the message id, and `<go>` sends;
  - `ui-context`: the outline, and resolve round-trips;
  - `hints/ask`: `pickSuggestions` and `placeAfterDrag`.
- `./singularity build`. Then, in this worktree's build at
  `http://<worktree>.localhost:9000`:
  1. ? → Ask equin opens the card bottom-right with three suggestions.
  2. "What can I do on this page?" streams an answer about the current page.
     Its Show me spotlights real controls, with no labels written anywhere.
  3. Minimize, switch apps: the pill follows and shows progress, then the
     unseen dot.
  4. Drag the card: it stays where it is dropped, and snaps near a corner. It
     keeps that position after a reload.
  5. Reply, and click a `<go>` ▶: both continue the same conversation.
  6. Ask it to change something. A filed-task card appears, and the task
     launches at once in a worktree, under main. Check that `add_task` is not
     in the agent's tool list, and that no other conversation sees
     `ask_file_task`.
  7. Ask it to write a file: the write is refused by the deny rules. This
     confirms deny is honoured under bypass mode.
  8. Done: the help task is dropped, and the filed task keeps running.
  9. Switch the model in Settings → Config: the next question runs on it.
- **A repeatable e2e script**, `plugins/hints/plugins/ask/e2e/ask.ts`, covers
  steps 1, 3, 4 and Done.
