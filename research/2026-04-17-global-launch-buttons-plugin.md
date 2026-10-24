# Unified `launch` plugin — reusable Sonnet/Opus buttons

## Context

Today, four separate places each re-implement the "create a new conversation" button group, with slightly different behavior:

| Location | File | Shape | Prompt | Model |
| --- | --- | --- | --- | --- |
| Homepage | `plugins/welcome/web/components/welcome-view.tsx` (L79–95) | Two buttons: **Sonnet** + **Opus** | none (blank) | from button |
| Conversation list (sidebar) | `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` (L74–91) | Two buttons: **Sonnet** + **Opus** | none (blank) | from button |
| Task detail | `plugins/tasks/web/components/task-detail.tsx` (L112–141, 191–199) | One button: **Launch agent** | `${title}\n\n${description}` | default (server-side) |
| Task list row | `plugins/tasks/web/components/launch-agent-action.tsx` | One icon button (`MdPlayArrow`) | `${title}\n\n${description}` (fetched from `/api/tasks/:id`) | default |

All of them do the same thing: `POST /api/conversations` with some subset of `{ model, prompt, taskId }`, then (on homepage/sidebar) open the resulting conversation pane. The task-side launchers don't auto-open the new pane today — worth unifying that too.

We want a single shared component, owned by a new `launch` plugin, that the four consumers can embed. The caller supplies a callback that returns the prompt + any task context at click time; the plugin owns the API call, loading state, and pane navigation.

## Design

### New plugin: `plugins/launch/`

```
plugins/launch/
  web/
    index.ts                  # PluginDefinition (no contributions)
    components/
      launch-buttons.tsx      # <LaunchButtons> — the shared component
```

It is a top-level plugin (mirroring `tasks`, `welcome`), not nested under `conversations`, because `tasks` consumes it and plugins shouldn't reach into another plugin's nested tree.

Plugin definition is nearly empty — its public surface is the exported component:

```ts
const launchPlugin: PluginDefinition = {
  id: "launch",
  name: "Launch",
  description: "Reusable Sonnet/Opus launch buttons for creating conversations.",
  contributions: [],
};
export default launchPlugin;
```

Registered in `web/src/plugins.ts` alongside the others.

### Public component API

```ts
// plugins/launch/web/components/launch-buttons.tsx

export type LaunchRequest = {
  prompt?: string;
  taskId?: string;
};

export type LaunchButtonsProps = {
  /**
   * Called at click time to produce the prompt + task context.
   * Sync or async. If omitted, the button launches a blank conversation
   * (current homepage / sidebar behavior).
   */
  getRequest?: () => LaunchRequest | Promise<LaunchRequest>;
  /** Navigate to the new conversation after creation. Default: true. */
  openAfterLaunch?: boolean;
  /** Visual variant. Default: "default" (filled). "outline" matches sidebar. */
  variant?: "default" | "outline";
  /** Size. Default: "default". "sm" matches sidebar. "icon" for inline rows. */
  size?: "default" | "sm" | "icon";
  /** Optional className for the wrapper. */
  className?: string;
};

export function LaunchButtons(props: LaunchButtonsProps): JSX.Element;
```

Behavior on button click (Sonnet or Opus):
1. Set an internal "launching" state (buttons disabled).
2. `request = await getRequest?.() ?? {}` — caller controls when to fetch.
3. `POST /api/conversations` with `{ model, ...request }`.
4. Parse response via `ConversationSchema`.
5. If `openAfterLaunch !== false`, `Shell.OpenPane(conversationPane({ session_id: conversation.id }))`.
6. Clear loading state.

Rendering:
- `size: "default" | "sm"`: two labeled buttons side by side (`flex gap-*`), each with `MdAdd` icon + model name. Matches the existing homepage / sidebar visual exactly.
- `size: "icon"`: two compact icon-only buttons (`MdPlayArrow` with model-colored dot, or stacked "S"/"O" letters — exact visual TBD during implementation, must stay readable at `size-6`). For the task-list row case, where horizontal space per row is tight.

Imports the component uses: `@/components/ui/button`, `@plugins/shell/web/commands` (for `Shell.OpenPane`), `@plugins/conversations/plugins/conversation-view/web/views` (for `conversationPane`), `@plugins/conversations/shared/types` (for `ConversationSchema`).

### Migrating the four call sites

All four lose their local `createConversation` / `launchAgent` functions and replace the button markup with `<LaunchButtons … />`.

**1. Homepage — `plugins/welcome/web/components/welcome-view.tsx`**
```tsx
// before: L29–37 createConversation + L79–95 two Buttons
<LaunchButtons />
```
Remove the now-unused `ConversationSchema` / `conversationPane` / `Shell` / `ConversationModel` imports.

**2. Sidebar — `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`**
```tsx
<LaunchButtons
  variant="outline"
  size="sm"
  openAfterLaunch={true}  // was: setActiveId(conversation.id) + openConversation
/>
```
The local `setActiveId` effect is already handled by the `popstate` / `shell:navigate` listener (L45–53), so the navigation from `Shell.OpenPane` inside `LaunchButtons` will drive the same state update. Remove the local `createConversation`.

**3. Task detail — `plugins/tasks/web/components/task-detail.tsx`**
```tsx
<LaunchButtons
  size="sm"
  getRequest={async () => {
    const trimmedTitle = title.trim() || "Untitled";
    await save({ title: trimmedTitle, description });
    const prompt = description.trim()
      ? `${trimmedTitle}\n\n${description}`
      : trimmedTitle;
    return { taskId, prompt };
  }}
/>
```
Replaces the single "Launch agent" button at L191–199 and the `launchAgent` callback at L112–141. Disable logic (`!title.trim()`) moves into `getRequest` returning early? Better: gate the whole `<LaunchButtons>` behind `title.trim()` (render nothing or render disabled — TBD; simplest is to conditionally render). Note: this gives task-detail a user-visible change — users now pick Sonnet vs Opus, rather than using a server-side default. That matches user intent ("unify the buttons").

**4. Task list row — `plugins/tasks/web/components/launch-agent-action.tsx`**
```tsx
<LaunchButtons
  size="icon"
  openAfterLaunch={false}  // preserve current behavior: don't yank user away
  getRequest={async () => {
    const res = await fetch(`/api/tasks/${taskId}`);
    if (!res.ok) return { taskId };
    const task = (await res.json()) as { title: string; description: string | null };
    const title = task.title.trim() || "Untitled";
    const prompt = task.description?.trim() ? `${title}\n\n${task.description}` : title;
    return { taskId, prompt };
  }}
/>
```
The whole `LaunchAgentAction` component becomes a thin wrapper around `<LaunchButtons size="icon" …>`. Its registration in `plugins/tasks/web/index.ts` (L30 — `TasksSlots.TaskActions({ id: "launch-agent", component: LaunchAgentAction })`) stays as-is; only the component internals change.

### Files to create / modify

- **Create:** `plugins/launch/web/index.ts` — `PluginDefinition`
- **Create:** `plugins/launch/web/components/launch-buttons.tsx` — the component
- **Create:** `plugins/launch/package.json` — workspace package (match `plugins/welcome/package.json` shape if one exists; otherwise follow another leaf plugin)
- **Modify:** `web/src/plugins.ts` — import and register `launchPlugin`
- **Modify:** `plugins/welcome/web/components/welcome-view.tsx` — replace button block, drop dead imports
- **Modify:** `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — replace button block, drop dead imports
- **Modify:** `plugins/tasks/web/components/task-detail.tsx` — replace Launch button, drop `launchAgent`
- **Modify:** `plugins/tasks/web/components/launch-agent-action.tsx` — reduce to `<LaunchButtons size="icon" …>` wrapper
- **Modify:** `docs/plugins.md` — add the `launch` plugin entry

### Non-goals (explicitly out of scope)

- No popover, no inline form, no prompt textarea in the plugin — callers own prompt construction (per user request).
- No server-side change. `POST /api/conversations` already accepts every field we need.
- No change to the `title` plugin's "Create child task" popover — it creates tasks, not conversations; it's not a launch button.
- No merging with `DeleteTaskAction` or other task actions; only the launch button is touched.

## Verification

1. `./equin build` — must succeed; frontend + server rebuild, gateway re-registers.
2. Open `http://<worktree>.localhost:9000`:
   - **Homepage**: click Sonnet → new conversation pane opens, sidebar shows it at the top. Repeat for Opus.
   - **Sidebar**: click Sonnet / Opus at top of conversation list → same behavior; active highlight moves to the new row.
3. Navigate to `/tasks`:
   - Hover a task row → see the compact icon launch buttons; click one → a new conversation is created under that task (verify the conversation has a link to the task), no navigation away from `/tasks`.
   - Click a task to open its detail pane → Sonnet / Opus buttons appear in place of the old "Launch agent" button; clicking opens the new conversation pane and the task stays linked.
4. Visual check: the buttons in the homepage and sidebar should look identical to today (same spacing / variant / size).
5. No TypeScript errors: `bun run typecheck` if available, otherwise let `./equin build` surface them.
