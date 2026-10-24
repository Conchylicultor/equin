# Unify the conversation item visual — v2

## What changed from v1

v1 put `ConversationItem` into the `conversations` umbrella's `web/` barrel next to `CONV_STATUS_DOT`. The umbrella barrel is already a grab-bag of types, hooks, and a color constant — adding a React component there grows that anomaly. v2 promotes the visual primitive to its **own sub-plugin** so it has a real home, a stable API surface, and somewhere to grow (more visual primitives, slot-based item actions in the future). Same component design as v1 — only the location changes.

## Context

(Same problem as v1 — every surface re-implements `[●] [title] [sys]` differently, with status text vs time vs nothing as the meta line. See the table in v1 for the full inventory.) The user's three named surfaces:

- Sidebar list — `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- Attempts in task detail — `plugins/tasks/plugins/task-events/web/components/task-events.tsx`
- Inline `conv-<id>` chip — `plugins/active-data/plugins/conv/web/components/conv-chip.tsx`

All three should show status dot + title + "sys" badge. Sidebar and Attempts also show relative time; the inline chip does not.

## Design

### New plugin: `plugins/conversations/plugins/conversation-item/`

Sibling of `conversation-view`, `conversations-view`, etc. Pattern matches `plugins/primitives/plugins/launch/` — a tiny plugin with no slot contributions, only exports.

```
plugins/conversations/plugins/conversation-item/
├── CLAUDE.md
├── package.json                      # @singularity/plugin-conversations-conversation-item
└── web/
    ├── index.ts                      # default-export plugin def + named re-exports
    └── components/
        └── conversation-item.tsx     # ConversationItem + atoms + formatRelativeTime
```

`web/index.ts` skeleton:

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
  id: "conversation-item",
  name: "Conversation Item",
  description: "Visual primitive for rendering a Conversation as a row or chip. Used by every surface that lists conversations.",
  contributions: [],
} satisfies PluginDefinition;
```

Surfaces import from the barrel: `@plugins/conversations/plugins/conversation-item/web` (long, but matches existing patterns like `@plugins/conversations/plugins/conversation-view/web`).

The plugin is registered in `web/src/plugins.ts` so it's part of the runtime registry.

### The component (unchanged from v1)

```tsx
type ConversationItemProps = {
  conv: Conversation;          // ConversationEntry from useConversations()
  layout?: "block" | "inline"; // default "block"
  active?: boolean;            // emphasize title (font-medium)
};
```

- **`layout="block"`** (default): `[●] [title] [sys]` on top, `[time]` (or `spawnedBy · time` for system) underneath. Used by sidebar + Attempts.
- **`layout="inline"`**: single line, `[●] [title] [sys]`, no time. Used by `conv-chip`.

Pure presentation — no click handler, no router awareness, no chrome. Surfaces wrap their own button/link.

Atoms exported alongside (`ConvStatusDot`, `ConvSysBadge`, `ConvTitle`, `ConvRelativeTime`) for surfaces with bespoke layouts (yak tree, welcome, recovery — out of scope for this PR but unblocked).

### Move `CONV_STATUS_DOT` into the new plugin

The current `plugins/conversations/web/status-dot.ts` is one constant. Visual primitives belong in the visual primitives plugin. We move it (delete `status-dot.ts`, drop the re-export from `plugins/conversations/web/index.ts`) and update the 7 import sites:

- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- `plugins/tasks/plugins/task-events/web/components/task-events.tsx`
- `plugins/agents/web/components/agent-launches.tsx`
- `plugins/attempt-view/web/components/attempt-pane.tsx`
- `plugins/yak-shaving/web/components/yak-tree-row.tsx`
- `plugins/active-data/plugins/conv/web/components/conv-chip.tsx`
- `plugins/agents/web/components/agent-status.tsx`

Most of these are migrating to `<ConversationItem>` anyway — those imports are removed entirely. Yak-tree and agent-status keep `CONV_STATUS_DOT` directly but rebind to the new path.

`plugins/conversations/web/index.ts` then exports only `useConversations`, `useConversation`, `useConversationById`, `GonePageSchema` — purely data hooks, no visual concerns.

### Why this shape, and the pattern it sets

1. **Single responsibility per plugin.** `conversations` (umbrella) owns the *domain* — types, hooks, server endpoints. `conversation-item` owns the *visual identity*. `conversation-view` owns the *full pane*. `conversations-view` owns the *sidebar list*. Each plugin answers one question.
2. **Repo convention for entity visuals.** This is the template every entity should follow:
   - `plugins/<entity>/plugins/<entity>-item/` — the visual primitive.
   - Sibling sub-plugins (lists, detail panes, runtimes) consume it.
   - Same recipe for `task-item`, `attempt-item`, `push-item` when those visuals start drifting too.
3. **Future extensibility for free.** Adding `ConversationItem.Action` slots later (so plugins can inject row actions like "fork", "close", "summarize") is a one-line `defineSlot` in this plugin's `web/index.ts`. Couldn't do that cleanly from a barrel constant.
4. **Cleaner barrel.** The `conversations` umbrella stops mixing data and presentation.

### Files to change

**New plugin (3 files):**
- `plugins/conversations/plugins/conversation-item/package.json`
- `plugins/conversations/plugins/conversation-item/CLAUDE.md` (one-line description; the autogen block is filled by `./equin build`)
- `plugins/conversations/plugins/conversation-item/web/index.ts`
- `plugins/conversations/plugins/conversation-item/web/components/conversation-item.tsx`

**Registry update:**
- `web/src/plugins.ts` — register `@plugins/conversations/plugins/conversation-item/web`.

**Conversations umbrella cleanup:**
- `plugins/conversations/web/status-dot.ts` — **delete**.
- `plugins/conversations/web/index.ts` — drop the `CONV_STATUS_DOT` re-export.

**Surface migrations (the three named):**
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx` — replace `ConversationContent` + `formatRelativeTime` + `statusDotClass` with `<ConversationItem conv={c} active={c.active} />`. Keep all sidebar chrome.
- `plugins/tasks/plugins/task-events/web/components/task-events.tsx` — replace lines 177–214 inline content with `<ConversationItem conv={c} active={isActive} />`. Drop the trailing status-text span (time becomes the meta line).
- `plugins/active-data/plugins/conv/web/components/conv-chip.tsx` — replace inline content with `<ConversationItem conv={conv} layout="inline" />` inside the existing button. Keep onClick routing + tooltip + "loading" fallback when `conv` is null.

**Import-only updates (no behavior change):**
- `plugins/agents/web/components/agent-status.tsx` — rebind `CONV_STATUS_DOT` to the new path.
- `plugins/yak-shaving/web/components/yak-tree-row.tsx` — same.

**Recommended easy follow-ups (in this PR if you want):**
- `plugins/attempt-view/web/components/attempt-pane.tsx` — `<ConversationItem layout="inline" conv={c} active={selected} />`.
- `plugins/agents/web/components/agent-launches.tsx` — `<ConversationItem layout="block" conv={primary} />`.

**Out of scope (custom multi-line layouts; flagged for future):**
- `plugins/yak-shaving/web/components/yak-tree-row.tsx` — context + next-action lines.
- `plugins/welcome/web/components/welcome-view.tsx` — uses hardcoded colors; should at minimum switch to `<ConvStatusDot>`.
- `plugins/conversations-recover/web/components/recovery-view.tsx` — model + ended-time variant.

## Verification

1. `./equin build` from the worktree — frontend type-checks (catches any missed `CONV_STATUS_DOT` import) and bundle rebuilds.
2. `./equin check --plugin-boundaries` — confirms the new plugin's barrel is well-formed and no surface deep-imports past it.
3. Open `http://att-1777459694-hrsy.localhost:9000`.
4. **Sidebar list** — same visual as today: status dot, title, sys, time, spawnedBy line for system rows. Toggle "show system" — system rows still tinted.
5. **Attempts under a task** — open a task in the Tasks pane; each conversation row shows status dot + title + sys + relative time (replacing today's status-text trailing span).
6. **Inline conv chip** — open a conversation containing a `conv-<id>` mention; chip shows status dot + title + sys, no time. Side-pane / full-screen click routing unchanged.
7. Optional Playwright before/after with `bun e2e/screenshot.mjs`.

## Critical files

- `plugins/conversations/plugins/conversation-item/web/index.ts` (new — plugin barrel)
- `plugins/conversations/plugins/conversation-item/web/components/conversation-item.tsx` (new — component + atoms)
- `web/src/plugins.ts` (registry)
- `plugins/conversations/web/index.ts` (drop `CONV_STATUS_DOT` export)
- `plugins/conversations/web/status-dot.ts` (delete)
- `plugins/conversations/plugins/conversations-view/web/components/conversation-list.tsx`
- `plugins/tasks/plugins/task-events/web/components/task-events.tsx`
- `plugins/active-data/plugins/conv/web/components/conv-chip.tsx`
- `plugins/agents/web/components/agent-status.tsx` (CONV_STATUS_DOT import rebind)
- `plugins/yak-shaving/web/components/yak-tree-row.tsx` (CONV_STATUS_DOT import rebind)
