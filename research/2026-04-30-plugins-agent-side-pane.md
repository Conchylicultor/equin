# Agent Side Pane in Conversation View

## Context

When viewing an agent conversation (where `conversation.kind === "agent"`), there is currently no way to quickly inspect or edit the agent that launched it without navigating away to the Agents main pane. The existing toolbar badge ("Agent" pill in `AgentChipToolbar`) provides visual context but is not actionable.

This change makes the agent chip a toggle button that opens an `AgentDetail` side pane alongside the conversation — exactly how `tasks-panel` opens `TaskDetail` on the side, or how `side-task` shows a related task. Users can edit the agent's name/description/prompt/model and see its launch history without leaving the conversation.

---

## Design

### Plugin location

All new code lives inside `plugins/agents/` — no new plugin needed. The agents plugin already:
- Contributes to `conversationPane.Actions` (the `AgentChipToolbar` badge)
- Defines panes as children of other panes (`agentConversationPane ⊂ agentDetailPane`)
- Has internal access to `AgentDetail`, `agentLaunchesResource`, `agentsResource`

Adding a `conversationPane`-child pane inside the agents plugin follows the same self-contained pattern.

### How `agentId` is resolved from a conversation

The conversation object (from `conversationPane.useData()`) carries `taskId`. The `agentLaunchesResource` (push-mode, already live) contains `{ agentId, taskId, … }` entries. The toolbar button resolves:
```ts
const launches = useResource(agentLaunchesResource).data ?? [];
const launch   = launches.find(l => l.taskId === conversation.taskId);
const agentId  = launch?.agentId;
```
This is a client-side lookup — no new endpoint or type change needed.

### `agentId` in the URL path

The pane path is `"agent/:agentId"` (child of `conversationPane`), so the full URL becomes `/c/<convId>/agent/<agentId>`. This enables:
- `expand: ({ agentId }) => \`/agents/${agentId}\`` — expand button jumps to the standalone agent detail pane
- The pane body reads `agentId` from `agentSidePane.useParams()` — no secondary lookup needed inside the body

### Updated `AgentChipToolbar`

The existing static badge is converted into an interactive button that toggles `agentSidePane`. The purple pill aesthetic is preserved; the background darkens when the pane is open. If `agentId` cannot be resolved (race, orphan), the element renders as a non-interactive badge as before.

---

## Files

### Modified

| File | Change |
|------|--------|
| `plugins/agents/web/panes.tsx` | Add `agentSidePane` (child of `conversationPane`, path `"agent/:agentId"`, expand to `/agents/:agentId`) |
| `plugins/agents/web/components/agent-chip-toolbar.tsx` | Convert static badge → toggle button; import `agentLaunchesResource`, `usePaneMatch`, `agentSidePane` |
| `plugins/agents/web/index.ts` | Add `Pane.Register({ pane: agentSidePane })` to contributions |

### Created

| File | Purpose |
|------|---------|
| `plugins/agents/web/components/agent-side-body.tsx` | Pane body: `agentSidePane.useParams()` → `<PaneChrome>` wrapping `<AgentDetail agentId={…} />` |

---

## Implementation Detail

### `panes.tsx` addition

```ts
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { AgentSideBody } from "./components/agent-side-body";

export const agentSidePane = Pane.define({
  id: "agent-side",
  parent: conversationPane,
  path: "agent/:agentId",
  component: AgentSideBody,
  chrome: {
    history: false,
    expand: ({ agentId }) => `/agents/${agentId}`,
  },
});
```

### `agent-side-body.tsx`

```tsx
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { useResource } from "@plugins/primitives/plugins/live-state/web";
import { agentsResource } from "../../shared/resources";   // follow existing pattern in agent-launches.tsx
import { AgentDetail } from "./agent-detail";
import { agentSidePane } from "../panes";

export function AgentSideBody() {
  const { agentId } = agentSidePane.useParams();
  const { data: agents } = useResource(agentsResource);
  const agent = (agents ?? []).find(a => a.id === agentId);

  return (
    <PaneChrome pane={agentSidePane} title={agent?.name ?? "Agent"}>
      <div className="h-full min-h-0 overflow-auto">
        <AgentDetail agentId={agentId} />
      </div>
    </PaneChrome>
  );
}
```

### `agent-chip-toolbar.tsx` update

Key changes:
- Import `usePaneMatch` from `@plugins/primitives/plugins/pane/web`
- Import `useResource` from `@plugins/primitives/plugins/live-state/web`
- Import `agentLaunchesResource` (relative, same plugin)
- Import `agentSidePane` from `../panes`
- Replace `<span>` with a `<button>` (or keep `<span>` but attach `onClick` + cursor + hover); highlight bg when `isOpen`
- Resolve `agentId` from `agentLaunchesResource`; if unresolved, render static non-clickable badge

```tsx
export function AgentChipToolbar() {
  const { conversation } = conversationPane.useData();
  if (conversation.kind !== "agent") return null;

  const match   = usePaneMatch();
  const isOpen  = match?.chain.some(e => e.pane === agentSidePane._internal) ?? false;
  const launches = useResource(agentLaunchesResource).data ?? [];
  const agentId  = launches.find(l => l.taskId === conversation.taskId)?.agentId;

  return (
    <button
      disabled={!agentId}
      aria-pressed={isOpen}
      onClick={() =>
        isOpen
          ? agentSidePane.close()
          : agentSidePane.open({ convId: conversation.id, agentId: agentId! })
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors",
        "text-violet-600 dark:text-violet-400",
        isOpen
          ? "bg-violet-500/30"
          : "bg-violet-500/15 hover:bg-violet-500/25",
        !agentId && "cursor-default pointer-events-none",
      )}
    >
      <MdPrecisionManufacturing className="size-3" />
      Agent
    </button>
  );
}
```

### `index.ts` contribution addition

```ts
Pane.Register({ pane: agentSidePane }),
```

---

## Key reused primitives

| Primitive | File |
|-----------|------|
| `Pane.define` / `Pane.Register` | `@plugins/primitives/plugins/pane/web` |
| `PaneChrome` | `@plugins/primitives/plugins/pane/web` |
| `usePaneMatch` | `@plugins/primitives/plugins/pane/web` |
| `useResource` | `@plugins/primitives/plugins/live-state/web` |
| `conversationPane` | `@plugins/conversations/plugins/conversation-view/web` |
| `AgentDetail` | `plugins/agents/web/components/agent-detail.tsx` (internal) |
| `agentLaunchesResource` | `plugins/agents/shared/resources.ts` (internal) |
| `agentsResource` | `plugins/agents/shared/resources.ts` (internal) |

---

## Verification

1. `./equin build` — no TS errors, no plugin-boundary violations
2. Open an agent conversation → "Agent" pill in the toolbar is now a button
3. Click the pill → right side pane opens showing the agent's name/description/prompt (full `AgentDetail`)
4. Pill background is darker (violet/30) when pane is open; reverts when closed
5. Pane chrome shows an expand icon → clicking it navigates to `/agents/<agentId>` (full agent detail page)
6. Open a user/system conversation (non-agent) → no pill visible (unchanged)
7. `./equin check` passes
