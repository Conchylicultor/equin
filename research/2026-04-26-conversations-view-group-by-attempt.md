# Conversation List: Group Active Conversations by Attempt

## Context

The conversation sidebar currently renders all conversations (active and gone) in a single flat chronological list. When multiple Claude agents are running inside the same worktree attempt (e.g. an original conversation plus one or more forks started from it), they appear as disconnected rows with no visual connection. Grouping them together — with the first conversation as the "root" and subsequent forks indented below — makes it immediately clear which agents are collaborating on the same work.

The change is UI-only: every `ConversationEntry` already carries `attemptId` (the shared key for all conversations in one worktree attempt). Only active conversations are grouped; gone conversations stay flat.

---

## Data model facts

- `ConversationEntry` fields relevant here:
  - `id: string`
  - `attemptId: string` — shared by all conversations in the same worktree attempt
  - `spawnedBy: string | null` — **not** a parent conversation pointer; it holds the worktree path or a string label like `"poller"`. Cannot be used for tree structure.
  - `status: "starting" | "working" | "waiting" | "gone"`
  - `title: string | null`
  - `createdAt: Date`
- Fork-conversation only reuses `attemptId`; no conversation-level parent pointer is stored anywhere.
- Active conversations arrive from the server ordered `createdAt DESC` (newest first).
- `SidebarMenuSub` / `SidebarMenuSubItem` / `SidebarMenuSubButton` are available in `web/src/components/ui/sidebar.tsx` but currently unused.

---

## Implementation

### Single file to change

**`plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`**

### Grouping logic (useMemo, active only)

```ts
const attemptGroups = useMemo(() => {
  // Group by attemptId, preserving insertion order (server sends newest-first,
  // so the first conversation encountered in each group is the most recently
  // started one — that group goes first).
  const map = new Map<string, ConversationEntry[]>();
  for (const c of active) {
    const group = map.get(c.attemptId) ?? [];
    group.push(c);
    map.set(c.attemptId, group);
  }
  // Within each group, sort oldest-first so the original conversation is at the
  // top and forks appear below it.
  return Array.from(map.values()).map((group) =>
    [...group].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  );
}, [active]);
```

Groups are ordered by the `createdAt` of their newest member (preserving the server's newest-first insertion order for the first item encountered per attempt).

### Render

Replace `active.map(renderItem)` with:

```tsx
{attemptGroups.map((group) => {
  const [root, ...forks] = group;
  if (forks.length === 0) return renderItem(root);
  return (
    <SidebarMenuItem key={root.attemptId}>
      <SidebarMenuButton
        className="h-auto py-1.5"
        isActive={root.id === activeId}
        onClick={() => { openConversation(root.id); setActiveId(root.id); }}
      >
        {/* same inner JSX as renderItem */}
      </SidebarMenuButton>
      <SidebarMenuAction onClick={(e) => closeConversation(root.id, e)} ...>
        <MdClose />
      </SidebarMenuAction>
      <SidebarMenuSub>
        {forks.map((fork) => (
          <SidebarMenuSubItem key={fork.id}>
            <SidebarMenuSubButton
              isActive={fork.id === activeId}
              onClick={() => { openConversation(fork.id); setActiveId(fork.id); }}
            >
              {/* same status dot + title + timestamp */}
            </SidebarMenuSubButton>
            {/* close action */}
          </SidebarMenuSubItem>
        ))}
      </SidebarMenuSub>
    </SidebarMenuItem>
  );
})}
```

### What does NOT change

- `renderItem` stays as-is and is still used for gone conversations (flat).
- Gone conversations: no grouping. `recentGone.map(renderItem)` and paginated gone remain flat.
- No backend changes. No new files. No schema changes. No new dependencies.
- No expand/collapse state — groups are always expanded (can be added later).

### Imports to add

```ts
import {
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from "@/components/ui/sidebar";
```

---

## Verification

1. `./equin build` from the worktree — confirms it compiles clean.
2. Screenshot `http://<worktree>.localhost:9000` after starting 2+ conversations in the same attempt (via the "+" fork buttons).
3. Verify: the grouped conversations appear clustered under the original, with indented sub-rows and a left border connecting them.
4. Verify: conversations in different attempts appear as separate top-level items.
5. Verify: gone conversations remain flat below the active groups.
6. Verify: clicking a sub-item navigates correctly and highlights that item as active.
