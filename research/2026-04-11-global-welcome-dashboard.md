# Welcome Pane — Empty State for Main Content Area

## Context

When no session is selected, the main content area is blank. The fix: a `welcome` plugin that registers a `/` route, rendering a welcome pane through the same pane/routing system used by conversations (`/c/:id`). No new concepts — just another pane.

## Approach

### 1. Remove `Shell.Main` — unify with panes

`Shell.Main` is currently unused and redundant with the pane system. Remove it:

- **`plugins/shell/web/slots.ts`**: Remove the `Main` slot definition
- **`plugins/shell/web/components/shell-layout.tsx`**: Remove `mains` usage, only render `panels`

### 2. Make `/` a routable path

Currently shell-layout explicitly skips `/` (lines 79, 94-96). Remove those early returns so `/` gets matched against registered routes like any other path.

### 3. Create `plugins/welcome/web/` plugin

**`plugins/welcome/web/views.tsx`** — View factory (same pattern as `conversationPane`):
```tsx
export function welcomePane(): PaneDescriptor {
  return { title: "Welcome", component: WelcomeView, path: "/" };
}
```

**`plugins/welcome/web/index.ts`** — Registers the `/` route:
```tsx
Shell.Route({ pattern: "/", resolve: () => welcomePane() })
```

**`plugins/welcome/web/components/welcome-view.tsx`** — The component:
- Centered layout, `max-w-md`
- Branding: "S" logo, "Singularity", "Agent Manager"
- Stats row: total / active / idle sessions (fetched from `GET /api/claude-sessions`)
- "New Session" button (POST + `Shell.OpenPane`)
- Recent sessions list (top 3, clickable)

### 4. Handle popstate to `/`

When user presses back to `/`, the popstate handler should resolve the welcome pane (instead of clearing panels to empty). This happens naturally once we remove the `/` skip and let it match the route.

### 5. Register plugin in `web/src/plugins.ts`

## Files

| Action | File |
|--------|------|
| Create | `plugins/welcome/web/index.ts` |
| Create | `plugins/welcome/web/views.tsx` |
| Create | `plugins/welcome/web/components/welcome-view.tsx` |
| Modify | `plugins/shell/web/components/shell-layout.tsx` — remove Main rendering, remove `/` skip |
| Modify | `plugins/shell/web/slots.ts` — remove `Shell.Main` |
| Modify | `web/src/plugins.ts` — register welcome plugin |

## Verification

1. `./equin build`
2. Navigate to `http://claude-1775914029.localhost:9000` — welcome pane shows
3. Click a session — navigates to `/c/<id>`, welcome disappears
4. Press back — returns to `/`, welcome pane reappears
