# Ask equin — implementation plan

Design and decisions: `research/2026-10-23-hints-ask-equin-floating-thread.md`.
Prototype: `proto-1792772741-le95f8` (chrome skin, default bottom-right).

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
| Agent context, tools, permissions | `defineScratchProfile` (`conversations/workspace/server`). Places' `ask/server/internal/profile.ts` is the pattern. |
| The checkout path | `getMainRepoRoot()` (`infra/spawn/core`) |
| Filing a task that auto-starts | `add_task` (`tasks/machine/internal/mcp-tools.ts`, policy in `add-task-filing.ts`) |
| A live task chip in the answer | active-data id chips (`task-…`, via `tasks/task-ids`). They already render in AgentThread's `Markdown`. |
| `<go>` choices | `active-data/plugins/go`. It needs a `PromptComposer`; see step 1. |
| Drag | `useDragGesture` (`primitives/dom/plugins/movable/web`) |
| Position persistence | `defineStore` (`primitives/dom/plugins/web-storage/web`) + `useDraft` (`primitives/persistent-draft/web`) |
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
- **Make `<go>` send.** `ThreadComposer` (`agent-thread/web/components/composer.tsx`)
  registers `useRegisterPromptComposer({ insert, send, canSend })`. `send` goes
  to the existing `sendConversationTurn`, and `insert` goes to the draft.
  `AgentThread` mounts a `PromptComposerProvider`. Once these are wired, `<go>`
  shows its ▶ and editing in the thread.
- Unit tests: `groupThread` carries the message id. A jsdom test checks that a
  `<go>` in an answer sends a turn.

### 2. `add_task`: file a task that starts now

- **Add an `independent` relation.** Today a main-track filing is a follow-up
  of the calling task, so it would launch only after the help thread ends.
  `relation: "independent"` adds no dependency edge. With `autostart`, the
  task is armed with nothing to wait on, so the launcher starts it
  immediately. The help task can then be dropped (Done) without affecting it.
- **Don't copy the help agent's workspace.** `inheritLaunchOptions` copies the
  calling task's launch options. It must not copy the scratch workspace,
  because the filed task needs a real worktree. Check whether the workspace
  option is inheritable. If it is, an `independent` filing leaves it unset.
- Update the tool description so agents know when to use `independent`.
- Tests are in `add-task-filing.test.ts`:
  - an independent filing has no edges;
  - it is armed;
  - it gets no workspace.

### 3. `hints`: point at a control on demand

- **Label anchors.** `defineHintAnchor(id, …)` gains an optional `label` ("the
  Share button") that agents can read.
- **List what's on screen.** `useMountedAnchors()` returns `{key, label}[]` for
  the anchors rendered right now. It is built on the existing
  `subscribeAnchors` and `isRendered` (`hints/web/internal/anchor-registry.ts`).
- **One-off spotlight.** `pointAt(key, { body })` is a one-step spotlight:
  `HintHost` turns it into a transient `StageScene` drawn by the same
  `HintStage`, with Back and Next. If the anchor is not mounted, it says so;
  it never fails silently.
- Add labels to the anchors that already exist. Show me only covers labelled
  anchors, so coverage grows as plugins label theirs.

### 4. `active-data/plugins/show-me`: a new inline tag

- `<show-me anchor="…">Share</show-me>` renders as a small target chip; clicking
  it calls `pointAt`.
- It works in any conversation, including the full Agent Manager view, and in
  AgentThread thanks to step 1.
- An unknown or unmounted anchor renders the chip disabled, with a tooltip
  saying why.

### 5. `apps-core/tabs`: the focused tab's title

- Export `useFocusedTabTitle()`, a module signal like the existing
  `focusedApp`. `Core.Root` sits outside `TabsProvider`, so it cannot call
  `useTabs`.

### 6. New plugin `plugins/hints/plugins/ask`

**`core/`**
- `HELP_ASK_PROFILE = "help.ask"`.
- `AskInputSchema`: `{ app, appName, path, title, anchors: {key, label}[] }`.
- The suggestion data: `ALWAYS` (2 questions) and `ROTATE` (3).
- A pure `pickSuggestions(random)`, tested.

**`server/`** registers the scratch profile with
`ScratchProfile.define(defineScratchProfile({…}))`:
- **Instructions** come from the current `askHowToPrompt` brief, plus:
  - the checkout path (`getMainRepoRoot()`);
  - the page context;
  - the anchors it may point at, with how to write `<show-me>`;
  - offer next steps as `<go>`;
  - to make a change, call `add_task` with `relation: "independent"`, track
    `main` and `autostart`, and write the returned `task-…` id in the answer,
    where it renders as a live chip;
  - end the turn and never call `exit_clean`.
- **Tools** (`mcpTools`): `add_task` and `flag_raise`.
- **Permissions**: `allow: Read, Grep, Glob, WebFetch`;
  `deny: Write, Edit, NotebookEdit, Bash`.

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
  (`TextEditor`). The first send captures the page context
  (`useActiveApp`, `usePathname`, `useFocusedTabTitle`, `useMountedAnchors`)
  and calls `useStartThread({ profile: HELP_ASK_PROFILE, categoryId:
  HELP_CATEGORY_ID, model: "opus" })`.
- **Thread.** `<AgentThread conversationId results={[]} …>`.
- **Header.** The question as title, plus:
  - Open in Agent Manager (`conversationRoute` via `navigate`);
  - New question (lets go of the run, which stays in the Agent Manager);
  - Minimize;
  - `EndThreadButton` (Done).
- **The pill** reads `useThreadProgress`: the step it is on while working, and
  an unseen dot when an answer arrives.

**`help-menu`**: delete `AskEquinEntry`, `openAskDialog` and `askHowToPrompt`
(the brief moves to `ask/server`). Update its index description.

## Known limits (v1)

- **Page context at first send only.** It is captured when the question is
  first sent. A follow-up from another page doesn't tell the agent about the
  new page.
- **Show me is limited.** It reaches only labelled hint anchors, which are few
  today.
- **The step list is AgentThread's own look**, not the prototype's "N steps"
  fold. Restyling it is a later polish pass.

## Verification

- **Tests**, one plugin at a time (`./singularity test <plugin>`):
  - `agent-thread`: the message id, and `<go>` sends;
  - `tasks`: independent filing;
  - `hints/ask`: `pickSuggestions` and `placeAfterDrag`;
  - `hints`: `useMountedAnchors`.
- `./singularity build`. Then, in this worktree's build at
  `http://<worktree>.localhost:9000`:
  1. ? → Ask equin opens the card bottom-right with three suggestions.
  2. "What can I do on this page?" streams an answer about the current page.
     Its Show me spotlights a labelled control.
  3. Minimize, switch apps: the pill follows and shows progress, then the
     unseen dot.
  4. Drag the card: it stays where it is dropped, and snaps near a corner. It
     keeps that position after a reload.
  5. Reply, and click a `<go>` ▶: both continue the same conversation.
  6. Ask it to change something: a task is filed under main and launches at
     once, in a worktree (not the help profile). Its chip in the answer is
     live.
  7. Ask it to write a file: the write is refused by the deny rules. This
     confirms deny is honoured under bypass mode.
  8. Done: the help task is dropped, and the filed task keeps running.
- **A repeatable e2e script**, `plugins/hints/plugins/ask/e2e/ask.ts`, covers
  steps 1, 3, 4 and Done.
