---
date: 2026-04-29
category: plugins
status: proposed
---

# `<conv>` chip → opens conversation in right side pane

## Context

Today, clicking a `<conv>conv-xxx</conv>` chip rendered by the
`active-data/conv` plugin calls `conversationPane.open({ convId })`, which
navigates the whole window to `/c/<convId>` and replaces the conversation the
user was reading. That's a context-loss whenever an agent references a sibling
conversation from inline assistant text.

We want clicks to instead open the referenced conversation in a right side
pane alongside the current one — the same split layout already used for
`tasks-panel`, `terminal-pane`, `docs-button`, etc. v1 is **read-only**
(JSONL transcript + expand-to-pop-out chrome). Full interactivity (prompt
input, toolbar buttons that send turns, resume/exit, etc.) is tracked as a
follow-up task because it requires teaching `ConversationView`'s pane-match
logic to render safely as a leaf side pane.

## Approach

Add a new sub-plugin under `conversation-view` that defines a side-pane child
of `conversationPane`, and rewire the `<conv>` chip to open that side pane.

URL shape: `/c/:convId/c/:sideConvId` (e.g. `/c/A/c/B` = main A on the left,
side B on the right). Path segment `c/` reads naturally as "and another
conversation".

### New sub-plugin: `conversation-view/plugins/side-conversation/`

Mirror the structure of `terminal-pane` / `tasks-panel`:

```
plugins/conversations/plugins/conversation-view/plugins/side-conversation/
├── package.json
├── CLAUDE.md
└── web/
    ├── index.ts
    ├── panes.tsx
    └── components/
        └── side-conversation-body.tsx
```

**`web/panes.tsx`** — defines the side pane:

```ts
import { Pane, PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { SideConversationBody } from "./components/side-conversation-body";

export const convSidePane = Pane.define({
  id: "conv-side",
  parent: conversationPane,
  path: "c/:sideConvId",
  component: SideConversationBody,
  chrome: {
    history: false,
    expand: ({ sideConvId }) => `/c/${sideConvId}`,
  },
});
```

`chrome.expand` reuses the existing PaneChrome expand-button behavior (see
`PaneChromeConfig` in
`plugins/primitives/plugins/pane/web/pane.ts:48`) so the user can pop the
side conversation out into a full view.

**`web/components/side-conversation-body.tsx`** — read-only renderer:

```tsx
import { PaneChrome } from "@plugins/primitives/plugins/pane/web";
import { JsonlPane } from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web";
import { useConversation, useConversationById } from "@plugins/conversations/web";
import { convSidePane } from "../panes";

export function SideConversationBody() {
  const { sideConvId } = convSidePane.useParams();
  const live = useConversation(sideConvId);
  const fetched = useConversationById(live ? null : sideConvId);
  const conversation = live ?? fetched;

  if (!conversation) {
    return (
      <PaneChrome pane={convSidePane} title="Loading…">
        <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
          Loading conversation…
        </div>
      </PaneChrome>
    );
  }

  return (
    <PaneChrome
      pane={convSidePane}
      title={conversation.title ?? conversation.id}
    >
      <div className="h-full min-h-0 overflow-hidden">
        <JsonlPane conversation={conversation} />
      </div>
    </PaneChrome>
  );
}
```

Reuses:
- `JsonlPane` from
  `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/components/jsonl-pane.tsx:72`
  (already takes `conversation` as a prop — no pane-match coupling).
- `useConversation` / `useConversationById` from
  `plugins/conversations/web/use-conversations.ts:45,56`.

**`web/index.ts`** — registers and re-exports:

```ts
import type { PluginDefinition } from "@core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { convSidePane } from "./panes";

export { convSidePane } from "./panes";

export default {
  id: "conversation-side-conversation",
  name: "Conversation: Side conversation",
  description:
    "Right side pane that shows a second conversation alongside the current one (read-only viewer; expand to pop out).",
  contributions: [Pane.Register({ pane: convSidePane })],
} satisfies PluginDefinition;
```

No toolbar action — entry point is the `<conv>` chip, not a toolbar button.
The pane is purely a navigation target for now.

**`package.json`** — copy `terminal-pane/package.json` and rename. Add
`@singularity/plugin-conversation-side-conversation` to the appropriate
workspace consumers (active-data/conv) per bun-workspaces convention.

**`CLAUDE.md`** — short prose: "Right side pane that displays a second
conversation alongside the host, opened by `<conv>` chips and similar inline
references. Read-only JSONL view; expand chrome pops out to `/c/<sideConvId>`."

### Register the plugin in the web bootstrap

Add to `web/src/plugins.ts` (the only place default-imports of plugin
barrels are allowed per boundary rules):

```ts
import sideConversationPlugin from "@plugins/conversations/plugins/conversation-view/plugins/side-conversation/web";
// …
plugins: [..., sideConversationPlugin, ...]
```

### Rewire the conv chip

`plugins/active-data/plugins/conv/web/components/conv-chip.tsx` — change
the click handler to open the side pane instead of navigating:

```tsx
import { usePaneMatch } from "@plugins/primitives/plugins/pane/web";
import { conversationPane } from "@plugins/conversations/plugins/conversation-view/web";
import { convSidePane } from "@plugins/conversations/plugins/conversation-view/plugins/side-conversation/web";

export function ConvChip({ children }: { children: string; attrs: Record<string, string> }) {
  const sideConvId = children.trim();
  const conv = useConversationById(sideConvId || null);
  const match = usePaneMatch();
  const parentEntry = match?.chain.find(
    (e) => e.pane === conversationPane._internal,
  );
  const parentConvId = parentEntry?.params.convId;
  // ... existing visual code ...

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (parentConvId && parentConvId !== sideConvId) {
      // Inside a host conversation → open as right side pane.
      // Naturally handles being already in /c/A/c/B: parentConvId stays A,
      // so clicking <conv>C</conv> rewrites to /c/A/c/C (replace).
      convSidePane.open({ convId: parentConvId, sideConvId });
    } else {
      // Outside a conversation context, or self-reference → full view.
      conversationPane.open({ convId: sideConvId });
    }
  };
  // ... button ...
}
```

Self-reference fallback (clicking `<conv>A</conv>` while in `/c/A`) navigates
to the full view — no side-pane to A from A. Outside-conversation fallback
preserves existing behavior so chips elsewhere (if ever rendered) still work.

### Add the new sub-plugin's package as a workspace dep of active-data/conv

Cross-plugin imports go through the bun workspace. Add
`@singularity/plugin-conversation-side-conversation` (or whatever name the
new package takes) to
`plugins/active-data/plugins/conv/package.json`. Also update
`docs/plugins-details.md` and `docs/plugins-compact.md` via the existing
`plugins-doc-in-sync` regen path (`./equin check`).

## Files to create

- `plugins/conversations/plugins/conversation-view/plugins/side-conversation/package.json`
- `plugins/conversations/plugins/conversation-view/plugins/side-conversation/CLAUDE.md`
- `plugins/conversations/plugins/conversation-view/plugins/side-conversation/web/index.ts`
- `plugins/conversations/plugins/conversation-view/plugins/side-conversation/web/panes.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/side-conversation/web/components/side-conversation-body.tsx`

## Files to modify

- `plugins/active-data/plugins/conv/web/components/conv-chip.tsx` — switch
  `onClick` from `conversationPane.open` to `convSidePane.open` (with the
  parent-conv detection + fallback above).
- `plugins/active-data/plugins/conv/package.json` — add the new sub-plugin
  as a workspace dep.
- `web/src/plugins.ts` — register `sideConversationPlugin`.
- `plugins/active-data/plugins/conv/CLAUDE.md` — update the one-line
  description ("opens in side pane" → "opens in right side pane alongside
  the host conversation").

## Why the clean design path

Per CLAUDE.md guidance ("Prefer the clean, modern, best-practice design
over the hacky one"), this isn't a one-off bolt-on:

- The `<conv>` chip is a small concrete case for a bigger primitive: any
  inline `active-data` widget that references another entity can open it as
  a side pane via the same pattern. Future tags like `<task>`, `<doc>` can
  reuse the same architecture (parent-aware open-in-side).
- The side pane is itself a reusable destination: if other features ever
  want to open a second conversation alongside the current one (e.g. a
  "compare conversations" affordance, a future tasks panel "view related
  conversation" link), they can call `convSidePane.open(...)` directly.

## Follow-up

After merging v1, **call `mcp__singularity__add_task`** to file:

> **Make the `<conv>` side pane fully interactive.** v1 is read-only (JSONL
> only). Make the pane host the full ConversationView (prompt input,
> resume/exit/fork toolbar contributions). Requires `ConversationView`'s
> pane-match logic
> (`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx:64-69`)
> to no longer assume "conversationPane in chain ↔ render this conversation".
> Likely refactor: split `ConversationView` into a leaf `ConversationBody`
> (no pane-match) + a router-aware wrapper.

## Verification

1. Run `./equin build` from this worktree.
2. Open `http://<worktree>.localhost:9000/c/<some-conv-id>` for a
   conversation whose assistant text contains a `<conv>conv-xxx</conv>` tag
   (or send a prompt that produces one).
3. Click the chip → the URL becomes `/c/<host>/c/<chip>` and the right pane
   shows the chipped conversation's JSONL transcript.
4. Verify chrome: title shows the side conversation's title; expand button
   navigates to `/c/<chip>`; close button returns to `/c/<host>`.
5. Inside the side pane, click another `<conv>C</conv>` chip → URL
   rewrites to `/c/<host>/c/C` (replace, host unchanged).
6. Click a `<conv>` chip whose id equals the host id → falls back to the
   full /c view (no nested-self pane).
7. Run `./equin check --plugin-boundaries` to confirm the new
   import paths are legal and `plugins-doc-in-sync` is happy.
