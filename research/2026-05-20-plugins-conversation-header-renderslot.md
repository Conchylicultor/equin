# Conversation Header → renderSlot Contributions

## Context

The conversation pane header has two zones: a PaneChrome header bar (title + chips) and an ActionBar strip below it. The ActionBar is already a `defineRenderSlot`. But the header is fragmented across three mechanisms:

1. **`Conversation.TitlePrefix`** regular slot — agent avatar (1 contributor: agents plugin)
2. **`conversationPane.Actions(position: "left")`** regular slot — model, status, progress, category, allow-monitor chips
3. **Hardcoded title text** in ConversationView

**Goal**: unify into a single `Conversation.Header` renderSlot. Every segment — avatar, title, model, status, progress, category, allow-monitor — is a contribution. `TitlePrefix` is removed entirely.

## Design

### New sub-plugin: `header`

Create `plugins/conversations/plugins/conversation-view/plugins/header/`:

- **`web/slots.ts`** — defines `Conversation.Header` renderSlot
- **`web/components/header-view.tsx`** — `HeaderView` component
- **`web/components/conversation-title.tsx`** — title text contribution
- **`web/index.ts`** — barrel + plugin definition (contributes `ConversationTitle`)

Slot definition:
```ts
export const Conversation = {
  Header: defineRenderSlot<{ component: ComponentType }>("conversation.header"),
};
```

### HeaderView

Renders the full title area:

```tsx
export function HeaderView() {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Conversation.Header.Render>
        {(item) => <item.component />}
      </Conversation.Header.Render>
    </span>
  );
}
```

### ConversationTitle

Contributed by the header plugin with `id: "title"`:

```tsx
export function ConversationTitle() {
  const { conversation } = conversationPane.useData();
  return (
    <span className="truncate text-sm font-medium">
      {conversation.title ?? conversation.id}
    </span>
  );
}
```

### AgentAvatarTitlePrefix migration

The agents plugin changes from:
```ts
Conversation.TitlePrefix({ component: AgentAvatarTitlePrefix })
```
to:
```ts
Conversation.Header({ id: "agent-avatar", component: AgentAvatarTitlePrefix })
```

The component itself changes from receiving `{ conversation }` as a prop to reading `conversationPane.useData()` internally (same as all other Header contributors).

### PaneChrome title wrapper

PaneChrome wraps the `title` in `<span className="truncate text-sm font-medium">`. When `title` is a ReactNode (our `HeaderView`), this clips chips and cascades font styles. Fix: skip the wrapper for non-string titles.

```tsx
{resolvedTitle != null && resolvedTitle !== "" &&
  (typeof resolvedTitle === "string" ? (
    <span className="truncate text-sm font-medium">{resolvedTitle}</span>
  ) : (
    resolvedTitle
  ))}
```

### Default ordering

Plugin load order from `plugins.generated.ts`:

1. `agents` (line 24) → `id: "agent-avatar"`
2. `conversation-category` (line 63) → `id: "category"`
3. `conversation-progress` (line 64) → `id: "progress"`
4. `allow-monitor` (line 67) → `id: "allow-monitor"`
5. `header` (~line 82) → `id: "title"`
6. `model` (line 105) → `id: "model"`
7. `status` (line 114) → `id: "status"`

Default render: [avatar] [category] [progress] [allow-monitor] [title] [model] [status]

Not ideal (title in the middle), but this is the standard renderSlot tradeoff — the reorder system lets users drag items into their preferred order, and persisted ranks override registration order.

## Files

### New files
- `plugins/conversations/plugins/conversation-view/plugins/header/web/slots.ts`
- `plugins/conversations/plugins/conversation-view/plugins/header/web/components/header-view.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/header/web/components/conversation-title.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/header/web/index.ts`

### Modified files
1. **`plugins/primitives/plugins/pane/web/components/pane-chrome.tsx`** — skip title wrapper for ReactNode titles
2. **`plugins/conversations/plugins/conversation-view/web/components/conversation-view.tsx`** — use `<HeaderView />` as title, remove all TitlePrefix logic
3. **`plugins/conversations/plugins/conversation-view/web/slots.ts`** — remove `TitlePrefix`
4. **`plugins/conversations/plugins/conversation-view/plugins/model/web/index.ts`** — migrate to `Conversation.Header`
5. **`plugins/conversations/plugins/conversation-view/plugins/status/web/index.ts`** — migrate to `Conversation.Header`
6. **`plugins/conversations/plugins/conversation-progress/web/index.ts`** — migrate to `Conversation.Header`
7. **`plugins/conversations/plugins/conversation-category/web/index.ts`** — migrate to `Conversation.Header`
8. **`plugins/conversations/plugins/conversation-view/plugins/allow-monitor/web/index.ts`** — migrate to `Conversation.Header`
9. **`plugins/agents/web/index.ts`** — migrate from `Conversation.TitlePrefix` to `Conversation.Header`
10. **`plugins/agents/web/components/agent-avatar-title-prefix.tsx`** — read from `conversationPane.useData()` instead of props

## Implementation order

1. Create header sub-plugin (slots, header-view, conversation-title, index)
2. Modify PaneChrome to handle ReactNode titles
3. Update ConversationView to use HeaderView, remove TitlePrefix logic
4. Remove TitlePrefix from conversation-view/slots.ts
5. Migrate agents plugin: TitlePrefix → Header, update component to use useData()
6. Migrate all 5 chip contributors to Conversation.Header
7. `./equin build`
8. Visual verification

## Verification

1. `./equin build` passes
2. Normal conversation: title text visible with chips in header
3. Agent conversation: avatar + title + chips all in one row
4. AllowMonitorChip appears only when allow-files exist
5. Chips are reorderable via the reorder pen button
6. ActionBar row (below header) unaffected
7. Other panes unaffected by PaneChrome change
