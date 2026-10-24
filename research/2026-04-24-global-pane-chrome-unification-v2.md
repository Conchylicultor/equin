# PaneChrome unification v2 — pull conversation toolbar onto the chrome

## What changed vs v1

v1 marked `conversationPane` as "opt out" (`chrome: false`) because its
`ConversationView` already renders a bespoke toolbar via three slots
(`Conversation.Toolbar`, `Conversation.Title`, `Conversation.PromptBar`).
v2 folds the toolbar and title onto `<PaneChrome>` — so that pane becomes
a regular chromed pane — and leaves the prompt-bar alone (it's a
bottom-of-terminal surface, not chrome).

All other buckets and the core "explicit wrapping is the convention"
decision from v1 still stand.

## Does chrome support per-pane extensions?

Yes. Each pane auto-creates an `Actions` slot at
`Pane.define` time (`plugins/pane/web/pane.ts:427-429`):

```ts
const actionsSlot = defineSlot<{ component: ComponentType }>(
  `pane.${args.id}.actions`,
);
```

…and exposes it as `pane.Actions` (`pane.ts:283`). Any plugin can
register a button on any pane's chrome:

```ts
contributions: [
  conversationPane.Actions({ component: MyConvButton }),
  taskDetailPane.Actions({ component: RefreshTaskButton }),
],
```

`<PaneChrome>` reads contributors via `pane.Actions.useContributions()`
(`pane-chrome.tsx:71`) and renders each inside a `PluginErrorBoundary`.
This is the same slot machinery used everywhere else — so yes, chrome
actions are per-pane and extensible.

**Caveat:** the shape is minimal — just `{ component: ComponentType }`.
No `label`, `icon`, `onClick`, or `group`. If a contributor wants click
behavior or an icon button they render it inside their component. This
is different from `Conversation.Toolbar`'s shape, which we'll unpack
below.

## Migration: conversationPane → PaneChrome

### Current layout in `ConversationView` (`conversation-view.tsx:146-203`)

```
┌────────────────────────────────────────────────────────────┐
│ [Title slot ▾] [status-group toolbar] ← ←→ [other toolbar] │ ← custom header
├────────────────────────────────────────────────────────────┤
│                                                            │
│  terminal                         │  <Outlet/> (side pane) │
│                                                            │
├────────────────────────────────────────────────────────────┤
│     [section]  [section]  [section] ← PromptBar            │ ← above prompt input
└────────────────────────────────────────────────────────────┘
```

Three slots, three regions:

- **`Conversation.Toolbar`** — top bar. Contributors:
  `code/CodeToolbarSlot`, `jsonl-viewer/JsonlButton`, `model/ModelBadge`
  (group `status`), `open-app`, `status/StatusBadge` (group `status`),
  `tasks-panel/TasksButton`, `vscode`. Shape:
  `{ label?, icon?, onClick?, component?, group? }`.
- **`Conversation.Title`** — single contributor `title/ConversationTitle`.
  Shape: `{ component(conversation) }`. Renders a clickable popover, not
  a plain string.
- **`Conversation.PromptBar`** — bottom bar above the input. Contributors:
  `drop-and-exit`, `fork-conversation`, `hold-and-exit`, `push-and-exit`,
  `quick-prompts`, `resume`. Grouped into sections (`Fork`, `Exit`,
  `Prompts`) with `sectionOrder`. Lives in the prompt surface, not the
  top chrome.

### Target layout after migration

```
┌──────────────────────────────────────────────────────────┐
│ ‹ › [ConversationTitle popover]           [actions…] [⤢] │ ← PaneChrome
├──────────────────────────────────────────────────────────┤
│  terminal                    │  <Outlet/> (side pane)    │
├──────────────────────────────────────────────────────────┤
│  [Fork]  [Exit]  [Prompts]                                │ ← PromptBar (unchanged)
└──────────────────────────────────────────────────────────┘
```

### Per-slot migration

**`Conversation.Toolbar` → `conversationPane.Actions`**

- All 7 contributors flip from `Conversation.Toolbar({…})` to
  `conversationPane.Actions({ component: … })`.
- Each component reads the conversation via `conversationPane.useData()`
  instead of receiving it as a prop. This works because PaneChrome
  renders *inside* `conversationPane.Provider` (we control that in the
  `ConversationView` refactor below). `useData()` is already typed:
  `conversationPane` provides `{ conversation: ConversationRecord }`.
- `onClick` / `label` / `icon` shorthand is dropped. The two
  contributors that rely on it — `open-app/OpenAppButton` and
  `vscode/VscodeButton` — need a two-line bump to render a `<Button
  variant="ghost" size="icon">` themselves (the shorthand they use today
  is already rendered that way by `ConversationView` at lines 186-198).
  Small code lift; it also matches what other toolbar components
  already do.
- `group: "status"` (Model badge, Status badge) is **dropped**.
  Status badges flow into the right-side actions area alongside other
  buttons instead of sitting next to the title. This is a deliberate
  visual simplification — the two-group split is arbitrary and chrome
  doesn't natively support it. If it matters, we can add ordering via a
  per-contribution `order` field later (small extension to the slot
  shape); I'd rather let real pain motivate that.

**`Conversation.Title` → `PaneChrome` title (as ReactNode)**

- PaneChrome currently types `title?: string`. Widen to
  `title?: ReactNode` (`pane-chrome.tsx:9`). The only render site
  (`pane-chrome.tsx:27`) already wraps in a `<span>` — the span can
  stay, ReactNode fits fine. Truncation still works for plain strings;
  custom nodes opt in to whatever layout they want.
- Delete the `Conversation.Title` slot. Move `ConversationTitle` to be
  imported directly by the conversation pane wrapper and passed as
  `title={<ConversationTitle conversation={conversation}/>}`.
- Rationale for not making Title a generic slot on PaneChrome: only one
  contributor exists across the app, and it's tightly coupled to
  conversation data. A pane-level override via the prop handles it
  without a new global concept.

**`Conversation.PromptBar` — unchanged**

- Lives below the terminal, inside the body area. Not part of chrome.
- Stays as a conversation-view-owned slot. No migration.

### Rewriting `ConversationView`

`conversation-view.tsx:146-203` becomes:

```tsx
const body = (
  <div className="flex h-[calc(100svh-3rem)] min-h-0 flex-col overflow-hidden">
    <div className="min-h-0 flex-1 overflow-hidden">{mainArea}</div>
  </div>
);

if (!conversation) return body;
return (
  <conversationPane.Provider value={{ conversation }}>
    <PaneChrome
      pane={conversationPane}
      title={<ConversationTitle conversation={conversation}/>}
    >
      {body}
    </PaneChrome>
  </conversationPane.Provider>
);
```

The bespoke header `<div>` (lines 147-200) goes away entirely, along
with `toolbarItems` / `titleItems` / `TitleComponent` plumbing.
`promptBarItems` and the `<PromptBar>` render stay.

`conversationPane` in `panes.tsx:19-24` also gets an `expand` config so
sub-panes can pop out of the split (symmetry with `taskConversationPane`
— not strictly needed since `conversationPane` is already the root
conversation URL, but `history: true` is meaningful).

### Revised pane categorization

**A. Chrome ON (wrap with `<PaneChrome>`):**
- `welcomePane`, `settingsPane`, `statsPane`, `dbBackupPane`,
  `worktreeCleanupPane`, `logsPane`, `logChannelPane`.
- `taskDetailPane`, `agentDetailPane`.
- `taskConversationPane`, `agentConversationPane`.
- `convFileTreePane`, `globalFileTreePane`.
- `convJsonlPane`, `convReviewPane`.
- `screenshotPane`.
- **NEW: `conversationPane`** — after the toolbar/title migration above.

**B. Chrome OFF (`chrome: false`):**
- `tasksRootPane`, `agentsRootPane` — these own the top-level
  `ResizablePanelGroup`. A header above the split has no "back" parent
  and just eats vertical space.
- That's it. Everything else chromes.

## Files to modify

**PaneChrome API tweak:**
- `plugins/pane/web/components/pane-chrome.tsx:7-11` — widen `title` to
  `ReactNode`; fall back to `chrome.title` config when the prop is
  omitted (from v1).
- `plugins/pane/web/CLAUDE.md` — document "wrap by default" convention
  and `chrome: false` opt-out.

**Pane definition wraps** (as v1, unchanged): `welcome`, `config`,
`stats`, `debug/db-backup`, `debug/worktree-cleanup`, `debug/logs`,
`screenshot`, `code-explorer` (×2), `jsonl-viewer`, `review`, `tasks`
(×3 — two wrap + root opts out), `agents` (×3 same shape).

**Conversation-view migration (new in v2):**
- `plugins/conversations/plugins/conversation-view/web/slots.ts` —
  delete `Conversation.Toolbar`, delete `Conversation.Title`. Keep
  `Conversation.PromptBar`.
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:146-203`
  — strip the bespoke header, wrap in `<PaneChrome>` inside the
  `Provider`. Drop `toolbarItems`, `titleItems`, `TitleComponent`
  plumbing.
- `plugins/conversations/plugins/conversation-view/web/panes.tsx:19-24`
  — leave `conversationPane` as-is (chrome defaults to enabled); no
  `chrome: false` needed.
- `plugins/conversations/plugins/conversation-view/web/index.ts` — drop
  `Conversation.Toolbar` / `Conversation.Title` exports if they exist.

**Conversation toolbar contributors (7 plugins):**
Change `Conversation.Toolbar({ … })` → `conversationPane.Actions({
component: … })` in each. For the two with `onClick`/`icon` shorthand,
wrap the existing `icon` + `onClick` in a small component. Files:
- `…/code/web/index.ts` (CodeToolbarSlot — already a component, trivial
  swap).
- `…/jsonl-viewer/web/index.ts:13` (JsonlButton — component, trivial).
- `…/model/web/index.ts:11` (ModelBadge — component; drop
  `group:"status"`).
- `…/open-app/web/index.ts` (currently uses `label`+`icon`+`onClick` —
  wrap into `OpenAppButton` component that reads `conversationPane.useData()`).
- `…/status/web/index.ts` (StatusBadge — component; drop
  `group:"status"`).
- `…/tasks-panel/web/index.ts:13` (TasksButton — component, trivial).
- `…/vscode/web/index.ts` (same `label`+`icon`+`onClick` shorthand as
  open-app — wrap into a `VscodeButton` component).

**Conversation title contributor (1 plugin):**
- `…/title/web/index.ts` — **delete the contribution entirely**. Export
  `ConversationTitle` from the plugin's web surface so
  `conversation-view` can import and render it in `title={…}`.
  (Alternative: keep the plugin but export only the component; remove
  the `Conversation.Title` slot call.)

## Trade-offs of migrating conversationPane

- **Status badges move to the right.** Today they sit next to the title
  (group `status`); after migration they're in the actions cluster. I
  argued above this is fine; if not, a small `order` field on
  `pane.Actions` solves it.
- **Richer toolbar shape gets flattened.** `label/icon/onClick`
  shorthand is gone; two plugins (`open-app`, `vscode`) gain a ~5-line
  component each. The rest already use `component`.
- **`useData()` replaces the `conversation` prop.** Contributors no
  longer get it passed in. Less implicit but requires `useData()`
  everywhere — matches how all other per-pane data access works in the
  codebase.
- **Title-as-component is a minor chrome API extension.** `ReactNode` is
  the natural type for a slot's content; string-only was a limitation.
- **The title plugin loses its slot registration.** It becomes a plain
  component export used directly by `conversation-view`. Slight
  coupling but no global slot for a single contributor is a net
  simplification.

## Caveats and missing features (unchanged from v1, re-stated for completeness)

- Pane-scoped history buttons still call `window.history.back/forward`
  (`pane.ts:354,358`) — not actually per-pane yet.
- Per-pane `Actions` slot is empty until plugins start contributing. In
  v2 the conversation toolbar contributors populate it immediately, so
  `conversationPane`'s chrome lands with real content.
- `tasksRootPane` / `agentsRootPane` still opt out — their layout owns
  the whole viewport.

## Verification

1. `./equin build` and load the app at
   `http://<worktree>.localhost:9000`.
2. Visit `/c/<convId>`. Confirm:
   - Single top bar with ‹ › history, the ConversationTitle popover,
     and the migrated toolbar buttons (JSONL, Tasks, Review, Code, VSCode,
     OpenApp, ModelBadge, StatusBadge) on the right.
   - No duplicate header, no empty title area.
   - Terminal + PromptBar below are unchanged.
   - Clicking the Tasks / JSONL / Review / Code / Files buttons still
     opens the side panes / pages correctly.
3. Visit `/tasks/<id>/c/<convId>`. Confirm the task-split layout still
   works and the right-hand conversation pane shows its chrome with an
   expand button that jumps to `/c/<convId>`.
4. `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/c/<id> --out
   /tmp/conv` to capture the before/after.
5. For other bucket-A panes, sidebar-click through Welcome / Settings /
   Stats / Debug panes and confirm chrome shows (back/forward + title,
   actions area empty).
6. For bucket-B panes (Tasks, Agents), confirm no header was added above
   the resizable split.

## Out of scope (unchanged)

- Pane-scoped history stack.
- Auto-wrap at `PaneLevel` / lint to enforce wrapping.
- Adding a `group` / `order` field to `pane.Actions` — deferred until
  status-badge ordering becomes a real pain.
- Similar refactor for any other plugin-owned toolbars outside
  `ConversationView` (none exist today).
