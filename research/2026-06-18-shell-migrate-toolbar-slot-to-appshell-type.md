# Migrate Shell.Toolbar to AppShellToolbarItem

## Context

`Shell.Toolbar` in `plugins/shell/web/slots.ts` inlines its own all-optional shape:

```ts
{ label?: string; icon?: ComponentType<…>; onClick?: () => void; component?: ComponentType; group?: string; }
```

This is a duplicate of the canonical `AppShellToolbarItem` discriminated union from `app-shell`, which was recently hardened to make label-only items (no `onClick`, no `component`) unconstructable — closing a "silent renders nothing" footgun. The four non-load-bearing app toolbar slots (debug, file-explorer, studio, workflows) were already migrated. `Shell.Toolbar` was intentionally deferred because `shell` is load-bearing.

The slot is currently **dormant** — agent-manager omits `toolbarSlot`, so nothing contributes to it. The loose inline type keeps the footgun latent and risks future type drift as real contributions arrive.

## Goal

- Replace the inline shape with `AppShellToolbarItem`
- Fix `docLabel` to guard against label absence (union member `AppShellToolbarComponent` has no `label`)
- Remove the now-unused `ComponentType` import from `react`

## File to Change

**`plugins/shell/web/slots.ts`** — single file, minimal edit.

### Current state

```ts
import type { ComponentType } from "react";
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { AppShellSidebarItem } from "@plugins/primitives/plugins/app-shell/web";

export const Shell = {
  Sidebar: defineRenderSlot<AppShellSidebarItem>("shell.sidebar", {
    docLabel: (p) => p.title,
  }),

  Toolbar: defineRenderSlot<{
    label?: string;
    icon?: ComponentType<{ className?: string }>;
    onClick?: () => void;
    component?: ComponentType;
    group?: string;
  }>("shell.toolbar", {
    docLabel: (p) => p.label,
  }),
};
```

### Target state

```ts
import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { AppShellSidebarItem, AppShellToolbarItem } from "@plugins/primitives/plugins/app-shell/web";

export const Shell = {
  Sidebar: defineRenderSlot<AppShellSidebarItem>("shell.sidebar", {
    docLabel: (p) => p.title,
  }),

  Toolbar: defineRenderSlot<AppShellToolbarItem>("shell.toolbar", {
    docLabel: (p) => ("label" in p ? p.label : undefined),
  }),
};
```

Changes:
1. Remove `import type { ComponentType } from "react"` (no longer referenced)
2. Add `AppShellToolbarItem` to the existing `app-shell/web` import
3. Replace the inline object shape with `AppShellToolbarItem`
4. Change `docLabel: (p) => p.label` → `docLabel: (p) => ("label" in p ? p.label : undefined)` (mirrors all four migrated slots exactly)

## Pattern Reference

All four migrated slots use the identical docLabel guard:

```ts
// debug, file-explorer, studio, workflows — all identical:
Toolbar: defineRenderSlot<AppShellToolbarItem>("….toolbar", {
  docLabel: (p) => ("label" in p ? p.label : undefined),
}),
```

`"label" in p` narrows to `AppShellToolbarAction` (which carries `label?`) vs `AppShellToolbarComponent` (which has `label?: never`).

## Verification

1. `./equin build` — type-check passes, no new errors
2. `./equin check type-check` — confirms no TS drift
3. No contributors to `Shell.Toolbar` exist today, so no call-site updates are needed
