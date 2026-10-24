# URL-Based Routing for Persistent Panes

## Context

Currently, opening a pane (e.g. a conversation) is purely in-memory — refreshing the page loses the view, and there's no way to link to a specific conversation. The user wants URLs like `/c/<session-id>/` that persist the current view and are bookmarkable/shareable.

The gateway already serves `index.html` for all non-file, non-API paths (SPA fallback), so client-side routing works out of the box with no backend changes.

## Design

Use the existing slot system: plugins declare routes as slot contributions, and the shell resolves them.

### New primitives

1. **`path?: string` on `PaneDescriptor`** — When a pane has a path, opening it updates the URL.
2. **`Shell.Route` slot** — Plugins contribute `{ pattern, resolve }` to declare URL patterns.

### Flow

```
Page load at /c/session-123
  → ShellLayout reads Shell.Route contributions
  → Matches "/c/:id" pattern → resolve({ id: "session-123" })
  → Opens the returned PaneDescriptor (which includes path: "/c/session-123")

User clicks session in sidebar
  → Shell.OpenPane(conversationPane({ session_id: "..." }))
  → Handler sets panels state + history.pushState(path)
  → URL updates to /c/<session-id>

Browser back/forward
  → popstate event → re-match URL → open corresponding pane
```

## Changes

### 1. `plugins/shell/web/commands.ts` — Add `path` to PaneDescriptor

```typescript
export interface PaneDescriptor {
  title: string;
  component: ComponentType;
  path?: string;
}
```

### 2. `plugins/shell/web/slots.ts` — Add `Shell.Route` slot

```typescript
Route: defineSlot<{
  pattern: string;
  resolve: (params: Record<string, string>) => PaneDescriptor;
}>("shell.route"),
```

### 3. `plugins/shell/web/routing.ts` — New file, pattern matcher

Simple `:param` matcher. Strips trailing slashes, decodes URI components. ~15 lines.

### 4. `plugins/shell/web/components/shell-layout.tsx` — Routing logic

- Collect `Shell.Route.useContributions()`
- `OpenPane` handler: call `history.pushState` when `descriptor.path` is set
- `useEffect` on mount: match current URL against routes, open matching pane (with ref guard to run once)
- `useEffect` for `popstate`: re-match on back/forward, clear panels on `/`

### 5. `plugins/conversation/web/views.tsx` — Add path to factory

```typescript
path: `/c/${opts.session_id}`,
```

### 6. `plugins/conversation/web/index.ts` — Register route contribution

```typescript
contributions: [
  Shell.Route({
    pattern: "/c/:id",
    resolve: (params) => conversationPane({ session_id: params.id }),
  }),
],
```

## Verification

1. `./equin build`
2. Open http://claude-1775913419.localhost:9000 — default view, URL is `/`
3. Click a session in sidebar — URL updates to `/c/<session-id>`
4. Refresh the page — same conversation reopens
5. Navigate directly to `/c/<session-id>` — conversation opens
6. Use browser back — returns to `/` (empty main area)
7. Use browser forward — conversation reopens
8. Open a different session — URL changes, back goes to previous session
