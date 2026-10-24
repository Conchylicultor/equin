# ask

Ask equin: the ? menu's **Ask equin how to…** opens a floating, draggable card
holding ONE threaded conversation with a read-only help agent, over whichever
page the user is on. Plan: `research/2026-10-23-hints-ask-equin-implementation-v2.md`;
prototype `proto-1792772741-le95f8` (chrome skin).

## The agent (machine, plus the tool in server)

The profile lives in the desktop-only `machine/` half: it reads the checkout
from disk (its path, the CLAUDE.md copy), and a scratch session only launches
on the computer. The reserved `ask_file_task` tool and the config stay in the
portable `server/` half.

- **Profile `help.ask`** (`ScratchProfile.define`): an empty scratch dir whose
  CLAUDE.md is `askInstructions(input, checkout)` — the user's page (app, route,
  focused tab title), the page outline (`ui-context`'s `formatOutline`), the
  main checkout's path to read (`getMainRepoRoot()`, resolved once in
  `onReadyBlocking` because `instructions` is synchronous), and how to answer:
  `<show-me path element>` copied from an outline entry, next steps as
  `<go>`, anything needing a change filed with `ask_file_task`, end the turn,
  never `exit_clean`.
- **The repo's map**: `prepare` copies the checkout's root `CLAUDE.md` and
  every file it imports (its `@path` lines — today `docs/plugins-compact.md`)
  into `<dir>/repo-context/` (`copyRepoContext`, at every launch), and the
  profile's CLAUDE.md imports the copy. An import of a file outside the
  project waits on Claude Code's one-time external-import consent, which a
  headless session cannot give; one inside it needs none.
- **Permissions**: allow `Read` / `Grep` / `Glob` / `Bash`; deny `Write` /
  `Edit` / `NotebookEdit` (the session runs in bypass mode, so only `deny`
  removes a tool). Bash is safe to give because the profile is `sandbox:
  true`: Claude Code's sandbox lets its commands read anywhere (the checkout
  and its git history) and write only inside the scratch dir, with no
  network and no unsandboxed escape. MCP tools: `ask_file_task`,
  `flag_raise` — no `add_task`.
- **No question is special-cased**: the instructions say how to look things
  up (code, plugin docs, git history) and how to answer, never what to do for
  a given question.
- **`ask_file_task`** is reserved with `profiles: [HELP_ASK_PROFILE]`, so no
  other conversation lists it. It files a task with **no folder and no
  dependency edges** (dropping the help task — Done — leaves it running), and
  none of the help task's launch options (so it runs in the default worktree
  workspace, not the read-only scratch one), on the main track (no track row),
  under Improvements, authored by the help conversation, then arms it with
  `askConfig.taskModel`. Arming emits `tasks.autoStartArmed`, which wakes
  `tasks.maybe-launch` at once since nothing blocks the task — **on main only**
  (the launcher returns early in a worktree backend, so a worktree build files
  the task but does not launch it).
- **It answers the task's id** (`threadResultReply(askFiledTask, { taskId })`):
  `askFiledTask` declares that `output`, so the thread's accepted result
  carries it and the card reads the task by id. `askFiledTask` is `multiple`:
  every task a turn files is its own card.

## The card (web)

- **`AskHost` at `Core.Root`**, above every tab, so it follows the user across
  apps. A page-global module store (`ask-store.ts`) holds `{ mode: closed |
  open | min, conversationId }`; the help menu's entry reads it ("Back to your
  question" + the question while a run is minimized or closed).
- **Restore once per load**: the newest `help.ask` run (`useThreadRuns(…,
  { limit: 1 })`) is taken back as the pill when it is still working or has an
  unseen answer.
- **Placement**: a `ViewportOverlay` (popover layer — the portaled layers are
  the only ones it offers) holding a `Placed` box in the chrome's fixed theme.
  The position is `AskPosition` `{ h, hx, v, vy }`, anchored to the nearest
  edges (so the card grows away from its corner), persisted in
  `askPositionStore`. Dragged by its header row (`useDragGesture`; the live drag is
  `Placed`'s `shift`); on drop, `placeAfterDrag` (core, pure, tested) keeps it
  in the viewport and snaps only within `SNAP_DISTANCE` of a corner — the
  top-right corner sits below the action bar.
- **Empty state**: `pickSuggestions(Math.random)` (two fixed newcomer
  questions + one rotating) and a first-question `TextEditor` (draft in
  `askQuestionDraft`). The first send captures the context — `useActiveApp`,
  `usePathname`, `useFocusedTabTitle`, and
  `collectOutline(document.body, { exclude: [card] })` — and starts the run
  with `useStartThread` (Help category, `askConfig.model`). Sends wait while
  the config is loading.
- **Height**: the card hugs its content up to its max height (`CardFrame`'s
  `max-h-*`, which its one child inherits): the thread is `<AgentThread
  height="hug">`, the empty card a `Column fit` — so a first message is a
  short card that grows with the thread, then the turns scroll, the composer
  pinned at the bottom.
- **Thread**: `<AgentThread results={[askFiledTask]} header={…}>`. The card
  owns the header — ONE row, the whole of it the drag handle (a press on an
  action still clicks: `useDragGesture` drags from a control only past its
  threshold): the mark and the question, then Open in Agent Manager
  (`OpenConversationButton display="icon"`), New question (lets go of the run;
  it stays in the Agent Manager), Minimize and `EndThreadButton` (Done). No
  status in it — the steps show live in the body, the pill when minimized.
- **A filed task** renders as `FiledTaskCard`: `useLiveRow(taskRows, taskId)`
  — the live task's status and title, opening its detail pane. Loading until
  the point read answers; **not found means deleted**, never "not there yet":
  the tool committed the task before it returned, and the card exists only
  once the transcript holds that return, so the read (issued after) can only
  miss a task deleted since.
- **e2e**: `e2e/ask.ts` (asks nothing, so no agent): opens from ?, the
  corner and the suggestions, a free drag, the corner snap, the position
  surviving a reload, Close.
- **Pill**: `useThreadProgress` — the step it is on while working, the question
  once answered, a dot while unseen.
- The web barrel side-effect-imports the element picker's barrel so its
  contribution lineage markers (what the outline is made of) are in every
  composition that has the card.

## Limits (v1)

- The page context is captured at the first question only.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: Ask equin, web half: the ? menu's entry (Ask equin how to… / Back to your question), and the AskHost at Core.Root — a draggable card in the chrome's theme holding one threaded conversation with the help agent (AgentThread; a filed task shows as its live status and title, opening in the Agent Manager), above every tab so it follows the user across apps: suggested questions and a first-question box when empty (the first send attaches the focused app, route, tab title and the page outline), minimized to a pill with the step it is on and an unseen dot, its position kept edge-anchored and snapped only near a corner, and the newest unseen or working run taken back as the pill once per load. Registers the Ask equin config with both model pickers. Ask equin, server half: the help agent's reserved ask_file_task tool (a task with no folder or dependency edges, in the default worktree workspace, filed under Improvements and armed with the configured model so it launches at once), and the Ask equin config (the answering model, the filed tasks' model).
- Web:
  - Contributes:
    - `Core.Root` → `AskHost`
    - `HelpMenu.Entry` "Ask equin how to…" → `AskEquinEntry`
    - `ConfigV2.WebRegister` "config"
    - `DynamicEnum.Options` "Model for filed tasks"
    - `DynamicEnum.Options` "Model"
  - Uses: 54 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `conversations/agent-thread` ×7
    - `apps-core` ×2
    - `config_v2` ×2
    - `hints/help-menu` ×2
    - `primitives/css/coords` ×2
    - `primitives/css/ui-kit` ×2
    - `primitives/live-state` ×2
    - `primitives/persistent-draft` ×2
    - `primitives/ui-context` ×2
    - `tasks/task-status` ×2
    - `apps-core/chrome-theme.chromeThemeScope`
    - `apps-core/tabs.useFocusedTabTitle`
    - `conversations/model-provider.useModelChoiceOptions`
    - `conversations.useConversation`
    - `fields/dynamic-enum/config.DynamicEnum`
    - `network/live.useLiveRow`
    - `primitives/css/clip.clipClasses`
    - `primitives/css/column.Column`
    - `primitives/css/control-panel.ControlPanel`
    - `primitives/css/fill.Fill`
    - `primitives/css/line.Line`
    - `primitives/css/spacing.Stack`
    - `primitives/css/spinner.Spinner`
    - `primitives/css/status-dot.StatusDot`
    - `primitives/css/surface.Surface`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/css/viewport-overlay.ViewportOverlay`
    - `primitives/dom/movable.useDragGesture`
    - `primitives/dom/web-storage.defineStore`
    - `primitives/file-links.FileLinksWorkspaceProvider`
    - `primitives/icon-button.IconButton`
    - `primitives/loading.Loading`
    - `primitives/pane.useOpenPane`
    - `primitives/text-editor.TextEditor`
    - `primitives/ui-context/element-picker`
    - `shell/toast.showToast`
    - `tasks/task-detail.taskDetailPane`
    - `ui/icons.Icon`
- Server:
  - Contributes: `ConfigV2.Register` "config"
  - Uses:
    - `config_v2.ConfigV2`
    - `config_v2.getConfig`
    - `conversations/model-provider/catalog.getModelCatalog`
    - `infra/mcp.Mcp`
    - `tasks.armTaskAutoStart`
    - `tasks/task-category.setTaskCategory`
    - `tasks/tasks-core.createTask`
  - Register: `mcpTool('ask_file_task')`
- Core:
  - Uses:
    - `config_v2.defineConfig`
    - `conversations/agent-thread.defineThreadResult`
    - `conversations/model-provider.DEFAULT_MODEL_CHOICE`
    - `fields/dynamic-enum/config.dynamicEnumField`
    - `tasks/task-ids.taskIdKind`
  - Exports (types):
    - `AskInput`
    - `AskPosition`
  - Exports (values):
    - `ALWAYS_SUGGESTIONS`
    - `askConfig`
    - `askFiledTask`
    - `AskFiledTaskSchema`
    - `AskInputSchema`
    - `AskPositionSchema`
    - `CORNER_MARGIN`
    - `DEFAULT_ASK_POSITION`
    - `FILE_TASK_TOOL`
    - `HELP_ASK_PROFILE`
    - `pickSuggestions`
    - `placeAfterDrag`
- Cross-plugin:
  - Uses tokens:
    - `ui/tokens/color-palette --border`
    - `ui/tokens/color-palette --foreground`
    - `ui/tokens/color-palette --muted-foreground`
    - `ui/tokens/color-palette --popover`
    - `ui/tokens/color-palette --primary`
    - `ui/tokens/color-palette --primary-text`
    - `ui/tokens/density --space-md`
    - `ui/tokens/density --space-sm`
    - `ui/tokens/density --space-xs`
    - `ui/tokens/shadow --shadow-popover`
    - `ui/tokens/shape --radius`
    - `ui/tokens/shape --spacing`

<!-- AUTOGENERATED:END -->
