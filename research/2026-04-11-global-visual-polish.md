# Visual Polish Plan — Shell Chrome

**Goal:** Make the app look professional by improving the sidebar, toolbar, and status bar. No changes to the main content area.

## Current Problems

1. **No brand color** — entire palette is grayscale (zero chroma OKLCH). No visual identity.
2. **No sidebar header** — jumps straight into "Logs" group label. No app name/logo.
3. **Toolbar is flat** — all ghost buttons look identical, no visual hierarchy between actions.
4. **Session items lack status** — idle vs active differentiated only by italic text. `attached` field unused.
5. **Logs sidebar is bare** — channel names with no icons.
6. **No status bar** — hidden when empty, making the layout feel ungrounded.

---

## Plan

### 1. Introduce brand accent color

**File:** `web/src/app.css`

Add a subtle indigo accent (hue 260) to `--primary`, `--ring`, and `--sidebar-accent`. All other neutrals stay untouched.

Light mode changes:
- `--primary`: `oklch(0.205 0 0)` → `oklch(0.45 0.15 260)` (indigo)
- `--ring`: `oklch(0.708 0 0)` → `oklch(0.55 0.12 260)`
- `--sidebar-accent`: `oklch(0.93 0 0)` → `oklch(0.94 0.02 260)` (barely-there tint)
- `--sidebar-accent-foreground`: `oklch(0.205 0 0)` → `oklch(0.30 0.08 260)`

Dark mode equivalent adjustments to same variables.

### 2. Add sidebar header with app identity

**File:** `plugins/shell/web/components/shell-layout.tsx`

Import and use `SidebarHeader` (already exported from sidebar.tsx but unused):

```tsx
<SidebarHeader className="px-4 py-3">
  <div className="flex items-center gap-2">
    <div className="size-7 rounded-lg bg-primary flex items-center justify-center">
      <span className="text-primary-foreground text-xs font-bold">S</span>
    </div>
    <div className="flex flex-col">
      <span className="text-sm font-semibold tracking-tight">Singularity</span>
      <span className="text-[10px] text-muted-foreground leading-none">Agent Manager</span>
    </div>
  </div>
</SidebarHeader>
```

### 3. Improve toolbar visual structure

**Files:**
- `plugins/shell/web/components/shell-layout.tsx` — add vertical separator after sidebar trigger, bump gap
- `plugins/build/web/components/build-button.tsx` — change `variant="ghost"` → `variant="outline"`
- `plugins/worktree-switcher/web/components/worktree-dropdown.tsx` — change to `variant="outline"`, add status dot (`bg-primary` colored circle)

### 4. Session list status indicators

**File:** `plugins/claude-sessions/web/components/session-list.tsx`

- Add colored dot: `bg-primary` when active, `bg-muted-foreground/40` when idle
- Surface `attached` field as " · attached" suffix
- Remove `italic` from idle (muted color + dot is enough)
- Active sessions get `font-medium`
- "New session" button: `variant="ghost"` → `variant="outline"`

### 5. Logs sidebar icons

**File:** `plugins/logs/web/components/logs-sidebar.tsx`

Add `MdTerminal` icon before each channel name.

### 6. Always-visible status bar

**File:** `plugins/shell/web/components/shell-layout.tsx`

Render footer always (currently hidden when empty). Show "Singularity" as subtle fallback text. Bump height from `h-6` → `h-7`.

### 7. Subtle main area background

**File:** `plugins/shell/web/components/shell-layout.tsx`

Add `bg-muted/30` to `<main>` for slight contrast against white plugin panels.

---

## Files Modified (7 total)

| File | Changes |
|------|---------|
| `web/src/app.css` | Brand color in theme variables |
| `plugins/shell/web/components/shell-layout.tsx` | Sidebar header, toolbar separator, status bar, main bg |
| `plugins/claude-sessions/web/components/session-list.tsx` | Status dots, attached indicator, button variant |
| `plugins/build/web/components/build-button.tsx` | Button variant ghost → outline |
| `plugins/worktree-switcher/web/components/worktree-dropdown.tsx` | Button variant, status dot |
| `plugins/logs/web/components/logs-sidebar.tsx` | Channel icons |

No new plugins. No slot interface changes. No main content area changes.

## Verification

1. `./equin build`
2. Screenshot at `http://claude-1775912835.localhost:9000`
3. Verify both light and dark mode (toggle via toolbar)
4. Check sidebar header, colored dots, toolbar buttons, status bar all render correctly
