# Unify the conversation item visual — v3

## What changed from v2

v2 placed the visual primitive in a single sub-plugin `conversation-item`. v3 expands the scope to a `conversation-ui` umbrella that contains `item` as its first child sub-plugin — leaving room for sibling visual primitives later (cards, breadcrumbs, mention pills, …) without spawning more top-level plugins. v3 also commits to the **direct-import** rule: consumers import each child plugin's barrel directly. No re-exports through the umbrella, no re-exports through the `conversations` grandparent. Same component design as before.

## Context

Same problem as before — `[●] [title] [sys]` is re-implemented inconsistently across:

- Sidebar list — `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- Attempts (task detail) — `plugins/tasks/plugins/task-events/web/components/task-events.tsx`
- Inline `conv-<id>` chip — `plugins/active-data/plugins/conv/web/components/conv-chip.tsx`

…plus several other surfaces (full inventory in v1).

Goal: a single visual primitive every surface uses. Sets the repo-wide pattern for entity visuals.

## Design

### Plugin structure

```
plugins/conversations/plugins/conversation-ui/                   # umbrella
├── CLAUDE.md
├── package.json                                                  # @singularity/plugin-conversations-conversation-ui
├── web/
│   └── index.ts                                                  # plugin def only — no exports
└── plugins/
    └── item/                                                     # child
        ├── CLAUDE.md
        ├── package.json                                          # @singularity/plugin-conversations-conversation-ui-item
        └── web/
            ├── index.ts                                          # plugin def + named exports of the components below
            └── components/
                └── conversation-item.tsx                          # ConversationItem + atoms + formatRelativeTime + CONV_STATUS_DOT
```

The umbrella is logic-free for now (matches `active-data` / `infra` / `code` patterns where the umbrella mostly groups). It can grow shared slots/utilities later (e.g. a `ConversationUI.Action` slot if multiple visuals need pluggable actions).

### Direct-import rule

- Consumers of the visual primitive import from `@plugins/conversations/plugins/conversation-ui/plugins/item/web`. Long but matches existing patterns (`@plugins/conversations/plugins/conversation-view/plugins/side-conversation/web`).
- The `conversation-ui` umbrella's `web/index.ts` does **not** re-export from `item/`.
- The `conversations` umbrella's `web/index.ts` does **not** re-export anything from `conversation-ui` either. Its only remaining duty is data hooks (`useConversations`, `useConversation`, `useConversationById`, `GonePageSchema`).

### `item` plugin barrel

`plugins/conversations/plugins/conversation-ui/plugins/item/web/index.ts`:

```ts
import type { PluginDefinition } from "@core";

export {
  ConversationItem,
  ConvStatusDot,
  ConvSysBadge,
  ConvTitle,
  ConvRelativeTime,
  CONV_STATUS_DOT,
  formatRelativeTime,
  type ConversationItemProps,
} from "./components/conversation-item";

export default {
  id: "conversation-ui-item",
  name: "Conversation UI: Item",
  description:
    "Visual primitive for rendering a Conversation as a row or chip. Used by every surface that lists conversations.",
  contributions: [],
} satisfies PluginDefinition;
```

(The `from "./components/..."` is an *intra-plugin* file barrel, which is the existing convention — see `plugins/primitives/plugins/launch/web/index.ts`. The "no re-exports" rule applies to **cross-plugin** boundaries.)

### The component (unchanged)

```tsx
type ConversationItemProps = {
  conv: Conversation;          // ConversationEntry from useConversations()
  layout?: "block" | "inline"; // default "block"
  active?: boolean;            // emphasize title
};
```

- `layout="block"` (default) — `[●] [title] [sys]` on top, `[time]` (or `spawnedBy · time` for system) underneath. Sidebar + Attempts.
- `layout="inline"` — single line, `[●] [title] [sys]`, no time. Inline `conv-chip`.

Pure presentation: no click handler, no router awareness, no chrome. Surfaces wrap their own button/link.

Atoms (`ConvStatusDot`, `ConvSysBadge`, `ConvTitle`, `ConvRelativeTime`) are exported alongside for unusual layouts (yak tree, welcome, recovery — out of scope for this PR but unblocked).

### Move `CONV_STATUS_DOT` into the `item` plugin

`plugins/conversations/web/status-dot.ts` deletes; the constant lives in the `item` plugin alongside the component that uses it. The `conversations` umbrella's `web/index.ts` drops the `CONV_STATUS_DOT` export.

Seven import sites today:

- 5 are migrating to `<ConversationItem>` and lose the import entirely (sidebar list, task-events, conv-chip, attempt-pane, agent-launches).
- 2 keep `CONV_STATUS_DOT` directly and rebind to `@plugins/conversations/plugins/conversation-ui/plugins/item/web`:
  - `plugins/agents/web/components/agent-status.tsx`
  - `plugins/yak-shaving/web/components/yak-tree-row.tsx`

### Why this shape, and the pattern it sets

1. **Umbrella for visual primitives.** `conversation-ui` is a labeled drawer for *how a conversation looks*. New visuals (cards, mentions, breadcrumbs) land as siblings of `item`, not as new top-level plugins.
2. **Direct imports = no hidden coupling.** Each surface declares exactly which UI primitive it depends on; the boundary checker enforces it. No accidental "well it's also re-exported from conversations" paths.
3. **Repo-wide template.** For each domain entity that drifts visually:
   - `plugins/<entity>/plugins/<entity>-ui/` umbrella
   - `plugins/<entity>/plugins/<entity>-ui/plugins/item/` (and siblings)
   - Same recipe for `task-ui/item`, `attempt-ui/item`, `push-ui/item`.
4. **Cleaner separation.** `conversations` umbrella owns the data domain (types, hooks, server). `conversation-ui` owns visual identity. `conversation-view` / `conversations-view` own surfaces. Each plugin answers one question.

### Files to change

**New umbrella:**
- `plugins/conversations/plugins/conversation-ui/package.json`
- `plugins/conversations/plugins/conversation-ui/CLAUDE.md`
- `plugins/conversations/plugins/conversation-ui/web/index.ts` (plugin def only, `contributions: []`, no exports)

**New child plugin:**
- `plugins/conversations/plugins/conversation-ui/plugins/item/package.json`
- `plugins/conversations/plugins/conversation-ui/plugins/item/CLAUDE.md`
- `plugins/conversations/plugins/conversation-ui/plugins/item/web/index.ts`
- `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx`

**Registry:**
- `web/src/plugins.ts` — register both `conversation-ui` umbrella and `conversation-ui/plugins/item`.

**Conversations umbrella cleanup:**
- `plugins/conversations/web/status-dot.ts` — **delete**.
- `plugins/conversations/web/index.ts` — drop the `CONV_STATUS_DOT` re-export.

**Surface migrations (the three named):**
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — replace `ConversationContent` + local `formatRelativeTime` + `statusDotClass` with `<ConversationItem conv={c} active={c.active} />`. Keep all sidebar chrome (`SidebarMenuButton`, `SidebarMenuAction`, close button, attempt grouping).
- `plugins/tasks/plugins/task-events/web/components/task-events.tsx` — replace inline content (lines 177–214) with `<ConversationItem conv={c} active={isActive} />`. Drop the trailing status-text span (relative time becomes the meta line).
- `plugins/active-data/plugins/conv/web/components/conv-chip.tsx` — replace inline content with `<ConversationItem conv={conv} layout="inline" />` inside the existing button. Keep onClick routing + tooltip + the placeholder when `conv` is null.

**Import-only updates (no behavior change):**
- `plugins/agents/web/components/agent-status.tsx` — rebind `CONV_STATUS_DOT` to the new path.
- `plugins/yak-shaving/web/components/yak-tree-row.tsx` — same.

**Recommended easy follow-ups (in this PR if you want):**
- `plugins/attempt-view/web/components/attempt-pane.tsx` → `<ConversationItem layout="inline" conv={c} active={selected} />`.
- `plugins/agents/web/components/agent-launches.tsx` → `<ConversationItem layout="block" conv={primary} />`.

**Out of scope (custom multi-line layouts):**
- `yak-shaving/yak-tree-row.tsx`, `welcome/welcome-view.tsx`, `conversations-recover/recovery-view.tsx`. Welcome should at minimum switch to `<ConvStatusDot>` to stop using its hardcoded color list.

## Verification

1. `./equin build` from the worktree — frontend type-checks and bundle rebuilds.
2. `./equin check --plugin-boundaries` — confirms both new plugins' barrels are well-formed and surfaces don't deep-import past them.
3. `./equin check --plugins-doc-in-sync` — autogen blocks update.
4. Open `http://att-1777459694-hrsy.localhost:9000`.
5. **Sidebar list** — same visual as today (status dot, title, sys, time, spawnedBy line for system rows). System toggle still tints rows.
6. **Attempts under a task** — open a task in the Tasks pane; conversation rows show status dot + title + sys + relative time (replacing the status text).
7. **Inline conv chip** — open a conversation containing a `conv-<id>` mention; chip shows status dot + title + sys, no time. Side-pane / full-screen routing unchanged.
8. Optional Playwright before/after via `bun e2e/screenshot.mjs`.

## Critical files

- `plugins/conversations/plugins/conversation-ui/web/index.ts` (new umbrella barrel)
- `plugins/conversations/plugins/conversation-ui/plugins/item/web/index.ts` (new — plugin barrel + exports)
- `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx` (new — component + atoms)
- `web/src/plugins.ts` (registry)
- `plugins/conversations/web/index.ts` (drop `CONV_STATUS_DOT` export)
- `plugins/conversations/web/status-dot.ts` (delete)
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- `plugins/tasks/plugins/task-events/web/components/task-events.tsx`
- `plugins/active-data/plugins/conv/web/components/conv-chip.tsx`
- `plugins/agents/web/components/agent-status.tsx` (`CONV_STATUS_DOT` import rebind)
- `plugins/yak-shaving/web/components/yak-tree-row.tsx` (`CONV_STATUS_DOT` import rebind)
