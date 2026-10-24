# PaneChrome unification v3 — chrome positions, shared icon-button, plain titles

## What changed vs v2

Three refinements:

1. **`pane.Actions` gains a `position: "left" | "right"` field** (default
   `right`) so contributors can sit on either side of the title.
   Replaces the "drop the `group` distinction" compromise from v2 —
   status badges keep their on-the-left placement.
2. **A reusable `<PaneIconAction>` component** is exported from the pane
   plugin so contributors don't have to hand-roll the same `<Button
   variant="ghost" size="icon">` shell. Open-app and VSCode become
   one-line wrappers around it.
3. **Drop the bespoke `ConversationTitle` popover.** Title becomes a
   plain string (consistent with every other pane). The "create child
   task" feature moves to a separate `+` button registered as a normal
   `conversationPane.Actions` contribution.

Everything else from v1/v2 still stands: explicit wrap convention,
chrome-on by default, two opt-outs (`tasksRootPane`, `agentsRootPane`).

## 1. Position field on `pane.Actions`

### Slot shape

`plugins/pane/web/pane.ts:283`:

```ts
Actions: Slot<{
  component: ComponentType;
  position?: "left" | "right";  // default "right"
}>;
```

…and at the `defineSlot` site (`pane.ts:427-429`):

```ts
const actionsSlot = defineSlot<{
  component: ComponentType;
  position?: "left" | "right";
}>(`pane.${args.id}.actions`);
```

Default `right` because the common case is "toolbar-style buttons on
the trailing edge"; left is reserved for status / contextual chips that
hug the title.

### Chrome render

`plugins/pane/web/components/pane-chrome.tsx:22-44` becomes (sketch):

```tsx
<div className="flex h-10 items-center gap-2 border-b px-2">
  {chrome.history && <PaneHistoryButtons pane={pane} />}
  <PaneActionsSlot pane={pane} position="left" />
  {resolvedTitle && (
    <span className="truncate text-sm font-medium">{resolvedTitle}</span>
  )}
  <div className="flex-1" />
  <PaneActionsSlot pane={pane} position="right" />
  {chrome.expand && <ExpandButton pane={pane} />}
</div>
```

`PaneActionsSlot` takes a `position` prop and filters
`pane.Actions.useContributions()` accordingly (treating missing
`position` as `"right"`). Returns `null` when its filtered list is
empty — no extra padding for unused sides.

### Why position and not order

Order numbers tempt contributors to pick magic numbers. Position is
binary, easy to reason about, and covers the only real distinction we
have today (status-on-left vs actions-on-right). If a third zone ever
matters (centered? floating?) we can add it; until then, two is
enough.

## 2. Reusable `<PaneIconAction>`

New export from `@plugins/primitives/plugins/pane/web` (file:
`plugins/pane/web/components/pane-icon-action.tsx`):

```tsx
import type { ComponentType, ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function PaneIconAction({
  label,
  icon: Icon,
  onClick,
  children,
}: {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children ?? (Icon ? <Icon className="size-4" /> : null)}
    </Button>
  );
}
```

Same shape as the inline ghost-icon button `ConversationView` renders
today (`conversation-view.tsx:186-198`). Lifted into the pane plugin so
any contributor can use it.

### Caller pattern

```tsx
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { PaneIconAction } from "@plugins/primitives/plugins/pane/web";
import { MdRocketLaunch } from "react-icons/md";

function OpenAppButton() {
  const { conversation } = conversationPane.useData();
  return (
    <PaneIconAction
      label="Open app"
      icon={MdRocketLaunch}
      onClick={() =>
        window.open(`http://${conversation.attemptId}.localhost:9000/`, "_blank")
      }
    />
  );
}

export default {
  id: "conversation-open-app",
  name: "Conversation: Open App",
  description: "Opens the conversation's namespace at http://<id>.localhost:9000/",
  contributions: [conversationPane.Actions({ component: OpenAppButton })],
} satisfies PluginDefinition;
```

VSCode plugin follows the same shape. Each contributor file goes from
~20 lines to ~25 — small bump, big consistency win, and you can pass
`children` for non-icon content (chips, badges, dropdowns).

### Naming / location

Exported alongside `PaneChrome`, `PaneActionsSlot`, `PaneHistoryButtons`
from `plugins/pane/web/index.ts`. Lives in the same folder. The
"reusable like TreeList" framing is right — it's a primitive UI
component the framework provides.

## 3. ConversationTitle → plain text + `+` action

### Title becomes a plain string

`ConversationView` passes a string to `<PaneChrome>`:

```tsx
<PaneChrome
  pane={conversationPane}
  title={conversation.title ?? conversation.id}
>
```

No popover, no clickable title — same look as `taskDetailPane` /
`agentDetailPane` / every other pane. Truncation is handled by the
existing `<span className="truncate text-sm font-medium">` inside
PaneChrome.

### `+` button as its own action

Rename the `title` plugin to **`new-child-task`**. It contributes a
`+` icon button that opens the same popover-with-textarea flow as
today, but as a standalone right-side action:

```tsx
function NewChildTaskAction() {
  const { conversation } = conversationPane.useData();
  // existing popover + form + submit → POST /api/tasks with parentId
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <PaneIconAction label="New child task" icon={MdAdd} />
      </PopoverTrigger>
      <PopoverContent>
        <CreateChildTaskForm … />
      </PopoverContent>
    </Popover>
  );
}

export default {
  id: "conversation-new-child-task",
  name: "Conversation: New Child Task",
  description: "Adds a child task under the conversation's parent task.",
  contributions: [conversationPane.Actions({ component: NewChildTaskAction })],
} satisfies PluginDefinition;
```

Move `conversation-title.tsx` → `new-child-task-action.tsx` (or
similar) inside the renamed plugin folder. Reuse the existing
`CreateChildTaskForm` body verbatim — only the trigger changes from
"clickable title text" to a `+` icon.

### Slot deletion

`Conversation.Title` slot is removed entirely from `slots.ts`. No
contributors remain.

## 4. Revised conversation-view migration

With v3 changes baked in:

**`Conversation.Toolbar` → `conversationPane.Actions`** (7 contributors)

| Plugin | New `position` | Notes |
|---|---|---|
| `model/ModelBadge` | `left` | Was `group: "status"`. |
| `status/StatusBadge` | `left` | Was `group: "status"`. |
| `code/CodeToolbarSlot` | `right` (default) | Already a component. |
| `jsonl-viewer/JsonlButton` | `right` | Already a component. |
| `tasks-panel/TasksButton` | `right` | Already a component. |
| `open-app` | `right` | Reshape into `OpenAppButton` using `PaneIconAction`. |
| `vscode` | `right` | Reshape into `VscodeButton` using `PaneIconAction`. |

**`Conversation.Title` → deleted slot.** Plugin renamed to
`new-child-task`; contributes a right-side `+` action.

**`Conversation.PromptBar`** — unchanged. Lives below the terminal,
not in chrome.

### `ConversationView` rewrite

`conversation-view.tsx:146-203` collapses to:

```tsx
const body = (
  <div className="flex h-[calc(100svh-3rem)] min-h-0 flex-col overflow-hidden">
    <div className="min-h-0 flex-1 overflow-hidden">{mainArea}</div>
    {conversation && promptBarItems.length > 0 && (
      <PromptBar items={promptBarItems} conversation={conversation} />
    )}
  </div>
);

if (!conversation) return body;
return (
  <conversationPane.Provider value={{ conversation }}>
    <PaneChrome
      pane={conversationPane}
      title={conversation.title ?? conversation.id}
    >
      {body}
    </PaneChrome>
  </conversationPane.Provider>
);
```

Drop `toolbarItems`, `titleItems`, `TitleComponent` plumbing. The
header `<div>` (lines 147-200) is gone. PromptBar moves up into `body`
since it's the conversation's own surface, not chrome.

## 5. Files to modify

**Pane plugin (API + new helper):**
- `plugins/pane/web/pane.ts:283,427-429` — add `position` to the
  `Actions` slot shape.
- `plugins/pane/web/components/pane-chrome.tsx` —
  - Widen `title` to `ReactNode` (still useful even with plain strings,
    e.g., for badges with the title).
  - Fall back to `chrome.title` config when no `title` prop (v1 tweak).
  - Render `PaneActionsSlot` twice with `position="left"` and
    `position="right"`.
- `plugins/pane/web/components/pane-icon-action.tsx` — **new file**;
  exports `PaneIconAction`.
- `plugins/pane/web/index.ts` — export `PaneIconAction`.
- `plugins/pane/web/CLAUDE.md` — document the wrap-by-default rule, the
  `position` field, and `PaneIconAction`.

**Pane definition wraps** (same as v1/v2 — no change here): the 13
single-pane wraps + the two `chrome: false` opt-outs (`tasksRootPane`,
`agentsRootPane`).

**Conversation-view migration:**
- `plugins/conversations/plugins/conversation-view/web/slots.ts` —
  delete `Conversation.Toolbar`, delete `Conversation.Title`. Keep
  `Conversation.PromptBar`.
- `plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`
  — strip header/title plumbing, wrap with `<PaneChrome>` inside
  `Provider`, move PromptBar into the body block.
- `plugins/conversations/plugins/conversation-view/web/index.ts` — drop
  `Conversation.Toolbar` / `Conversation.Title` exports.
- `plugins/conversations/plugins/conversation-view/web/panes.tsx` —
  leave `conversationPane` as-is (chrome defaults on).

**Toolbar contributors (7 plugins):**
- `…/code/web/index.ts` — `Conversation.Toolbar({ component })` →
  `conversationPane.Actions({ component })`.
- `…/jsonl-viewer/web/index.ts:13` — same.
- `…/tasks-panel/web/index.ts:13` — same.
- `…/model/web/index.ts` — `position: "left"`. Drop `group:"status"`.
  ModelBadge reads `conversationPane.useData()` instead of receiving
  `conversation` as a prop.
- `…/status/web/index.ts` — same as model: `position: "left"`,
  `useData()`.
- `…/open-app/web/index.ts` — replace `label`+`icon`+`onClick`
  shorthand with an `OpenAppButton` component using `PaneIconAction`.
- `…/vscode/web/index.ts` — same as open-app, with a `VscodeButton`.

**Title plugin → new-child-task plugin:**
- Rename `…/title/` → `…/new-child-task/`.
- Update `id` and `name` in `package.json` and the plugin definition.
- Rename `conversation-title.tsx` → `new-child-task-action.tsx`.
- Replace the popover trigger (clickable title text) with a
  `<PaneIconAction label="New child task" icon={MdAdd}>` trigger.
  `CreateChildTaskForm` body stays verbatim.
- Contribute via `conversationPane.Actions({ component:
  NewChildTaskAction })` — default right position.
- `docs/plugins.md` will regenerate after build to reflect the rename.

## Trade-offs

- **`position` is binary, not ordered.** Two contributors on the same
  side land in registration order. Good enough; if pixel-perfect
  ordering matters, add `order?: number` later.
- **Status badges sitting next to title (left)** mean the title can be
  pushed slightly right when many badges contribute. Acceptable —
  matches the old layout where status was inline with the title.
- **`PaneIconAction` is opinionated** (ghost variant, icon size).
  Contributors who need different styling drop it and write their own
  `<Button>`. The component is a convenience, not a contract.
- **Plain title loses the popover affordance.** The "click title to
  add child task" gesture goes away — discoverability shifts to the
  `+` icon. Net positive: consistency with other panes; "+" is a more
  obvious target than text.
- **Plugin rename touches `package.json` and the `docs/plugins.md`
  generation.** Self-contained; no external references to the old
  `conversation-title` plugin id outside its own folder (verified by
  grep — the slot is the only coupling, and it's being deleted).

## Caveats / known gaps (carried from v1/v2)

- Pane history buttons still call `window.history.back/forward` —
  global history, not pane-scoped (`pane.ts:354,358`).
- `tasksRootPane` / `agentsRootPane` opt out (their layout owns the
  whole viewport).
- Per-pane Actions slots stay empty for most other panes until plugins
  start contributing. Conversation pane lands populated.

## Verification

1. `./equin build`; load at `http://<worktree>.localhost:9000`.
2. `/c/<convId>` — confirm the chrome bar shows:
   - ‹ › on the far left.
   - `[ModelBadge] [StatusBadge]` left of the title (position=left).
   - Plain conversation title (no popover).
   - On the right: existing toolbar buttons (Code, JSONL, Tasks,
     Review, Files, OpenApp, VSCode) + new `+` (new child task) button.
   - Terminal + PromptBar below unchanged.
3. Click `+` → popover opens with "Create child task" form, Cmd-Enter
   submits, toast appears, popover closes.
4. `/tasks/<id>/c/<convId>` — split layout still works; right pane
   shows its own chrome with expand button.
5. Sidebar-click through Welcome / Settings / Stats / Debug panes:
   chrome shows back/forward + title; actions area empty.
6. `bun e2e/screenshot.mjs` for `/c/<id>` to lock in the new header
   layout visually.
7. Tasks/Agents root panes: confirm no header above the resizable
   split.

## Out of scope

- Pane-scoped history.
- Auto-wrap at `PaneLevel`; lint to enforce wrapping.
- `order: number` field on Actions (only if `position` ordering becomes
  a real pain).
- Migrating `Conversation.PromptBar` onto chrome (it's intentionally
  not chrome — sits at the prompt input).
