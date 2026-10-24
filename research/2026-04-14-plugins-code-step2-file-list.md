# Code plugin — Step 2: file list

## Context

Step 1 shipped the Code meta plugin with a disabled toolbar button that shows
the edited-files count. Step 2 makes it interactive: clicking the button
toggles a pane between the toolbar and the terminal that lists the edited
files. Scope is the list only — no viewer, no syntax highlighting, no
resizable split, no row click. Step 3 adds the viewer as an independent slot
unrelated to this pane.

## Design

Use an imperative **command** (mirroring `Shell.OpenPane`) to show/hide the
pane. Only one middle pane can be set at a time; a later call replaces the
previous one. The file-list sub-plugin exposes a **view factory** (mirroring
`terminalPane` in `plugins/terminal/web/views.tsx`) that returns an opaque
descriptor — consumers never import the component directly.

### New command + hook

`plugins/conversations/plugins/conversation-view/web/commands.ts` (new):

```ts
export interface MiddlePaneDescriptor {
  id: string; // stable id so buttons can ask "is mine currently open?"
  component: ComponentType<{ conversation: ConversationState }>;
}

export const Conversation = {
  OpenMiddlePane: defineCommand<MiddlePaneDescriptor | null, void>(
    "conversation.open-middle-pane",
  ),
};
```

Companion read hook (in the same module or a small `hooks.ts` next to it):

```ts
export function useMiddlePane(): MiddlePaneDescriptor | null;
```

Implementation inside `conversation-view.tsx`:

```ts
const [middlePane, setMiddlePane] = useState<MiddlePaneDescriptor | null>(null);
Conversation.OpenMiddlePane.useHandler((d) => setMiddlePane(d));
// expose middlePane via a small context so useMiddlePane() can read it
```

A React context (`MiddlePaneContext`) provides the value to `useMiddlePane`.
Context + provider live alongside the command in
`conversation-view/web/commands.ts` (or a sibling file) — this is the same
pattern `OpenPane` uses in the Shell layout.

Auto-close when the conversation changes: `useEffect(() => setMiddlePane(null), [conversation.id])`.

### Layout integration

`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`
renders the current middle pane between toolbar and terminal:

```tsx
<div className="flex items-center gap-2">{/* toolbar */}</div>
{middlePane && (
  <div className="h-[40vh] min-h-[160px] overflow-hidden rounded-md border bg-muted/30">
    <middlePane.component conversation={conversation} />
  </div>
)}
<div className="flex-1 overflow-hidden rounded-md border bg-muted/30">
  <TerminalComponent />
</div>
```

Fixed height for now. Terminal keeps `flex-1`, shrinking when the pane is open.

### File-list sub-plugin (view factory)

`plugins/…/code/plugins/file-list/` — no `index.ts` plugin definition needed
if it registers nothing statically. It only ships a view factory. Still needs
a `package.json` so workspace resolution works.

`plugins/…/code/plugins/file-list/web/views.tsx`:

```tsx
import type { MiddlePaneDescriptor } from "@plugins/…/conversation-view/web/commands";
import { EditedFileList } from "./components/edited-file-list";

export const EDITED_FILE_LIST_PANE_ID = "code.edited-file-list";

export function editedFileListPane(): MiddlePaneDescriptor {
  return { id: EDITED_FILE_LIST_PANE_ID, component: EditedFileList };
}
```

`components/edited-file-list.tsx`:

- Takes `{ conversation }` prop (injected by conversation-view).
- Calls `useEditedFiles(conversation.id)` (existing hook from step 1).
- Wraps rows in `web/src/components/ui/scroll-area.tsx`.
- Sorts: modified → added → untracked → deleted; alpha within each group.
- Empty state: centered `text-sm text-muted-foreground` "No edited files".

`components/file-row.tsx`:

```tsx
<div className="flex items-center gap-2 px-3 py-1 text-sm">
  <StatusDot status={status} />   {/* 6px dot, green/blue/amber/muted */}
  <FileIcon className="h-3.5 w-3.5 text-muted-foreground" />
  <span className="text-muted-foreground">{dir}</span>
  <span className="font-medium">{basename}</span>
</div>
```

Plain `<div>` — no click handler in step 2. `FileIcon` = lucide `File`.

No new sub-plugin registration needed in `web/src/plugins.ts` if the file-list
doesn't export a `PluginDefinition`. Its code is pulled in transitively when
the button imports the view factory.

### Button changes

`plugins/…/code/plugins/edited-files-button/web/components/edited-files-button.tsx`:

```ts
import { Conversation, useMiddlePane } from "@plugins/…/conversation-view/web/commands";
import { editedFileListPane, EDITED_FILE_LIST_PANE_ID } from "@plugins/…/code/plugins/file-list/web/views";

const current = useMiddlePane();
const isOpen = current?.id === EDITED_FILE_LIST_PANE_ID;
const onClick = () => Conversation.OpenMiddlePane(isOpen ? null : editedFileListPane());
```

- Drop the `disabled` prop.
- Active styling when `isOpen` (match whatever pattern neighboring toolbar
  buttons use; if none, `variant="secondary"` vs `variant="ghost"`).
- Tooltip becomes just "Edited files".

### Shared SSE (optional cleanup)

Step 1's `use-edited-files.ts` opens a fresh `ReconnectingEventSource` per
mount. Step 2 mounts it twice (counter + list). Two sockets work fine for
now; leave as-is. A shared-subscriber refactor is a straightforward follow-up
if load becomes a concern.

## Critical files

Create:
- `plugins/…/conversation-view/web/commands.ts` — command, descriptor type, provider, `useMiddlePane` hook.
- `plugins/…/code/plugins/file-list/package.json`
- `plugins/…/code/plugins/file-list/web/views.tsx`
- `plugins/…/code/plugins/file-list/web/components/edited-file-list.tsx`
- `plugins/…/code/plugins/file-list/web/components/file-row.tsx`

Modify:
- `plugins/…/conversation-view/web/components/conversation-view.tsx` — useState + handler + render middle pane; reset on conversation change; wrap in MiddlePaneContext provider.
- `plugins/…/code/plugins/edited-files-button/web/components/edited-files-button.tsx` — onClick, active state, read via `useMiddlePane`.

No changes:
- `web/src/plugins.ts` — file-list ships no `PluginDefinition`.
- Server — step 1's SSE endpoint is sufficient.
- Schema / migrations.

## Verification

1. `./equin build` succeeds.
2. `http://claude-1776167923.localhost:9000` — open a conversation with real edits.
3. Click the edited-files toolbar button → pane appears between toolbar and terminal; terminal shrinks.
4. Button shows active styling while pane is open.
5. List matches `git -C <worktree> diff --name-status main...HEAD` + `git status --porcelain`, sorted modified → added → untracked → deleted (alpha within).
6. Click the button again → pane closes, terminal regains full height, button de-activates.
7. Switch to another conversation while the pane is open → pane auto-closes (effect on `conversation.id`).
8. Edit a file in the worktree from a shell → list updates within ~1s (step-1 SSE tick).
9. Empty-state conversation → pane shows "No edited files".

## Out of scope (step 3)

- Independent file-viewer slot / plugin.
- Row click → select file → viewer coordination.
- Per-extension file icons, resizable pane height.
