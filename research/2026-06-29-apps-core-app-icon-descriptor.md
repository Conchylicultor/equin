# App-declared canonical icon descriptor

## Context

Every app contributes to the `Apps.App` slot with `icon: ComponentType<{ className?: string }>` —
a raw, opaque React component (today always a `react-icons/md` glyph passed directly, e.g.
`icon: MdHome`). This is **not a canonical, app-declared icon identity**:

- It is not serializable, so non-React consumers (future favicon, server-side, desktop/Tauri
  packaging) cannot read an app's icon.
- It cannot represent a custom image — only a glyph component.
- "An app's icon" is implicit in an arbitrary component reference rather than a first-class,
  inspectable property.

The `icon-picker` primitive already owns exactly the right serializable format for this
(`SvgNode[]` — a JSON-serializable `<svg>` child-tree) and its `CLAUDE.md` explicitly names
**app icons** as an intended future consumer alongside avatars and page icons.

**Goal (scope confirmed with user):** make the app icon a first-class, **serializable,
app-declared descriptor**, supporting a Material Design icon **now**, with the format shaped so a
custom-image variant drops in later. Out of scope for this task: runtime user override (persisted),
the uploaded-image pipeline, and actually wiring desktop/Tauri packaging — we only **design the
format** to be capable of feeding those later.

## Design

Introduce a **self-contained plugin** that owns the whole app-icon concept — the serializable
`AppIcon` descriptor, the author-time helper, and the renderer — then swap the `Apps.App` slot's
`icon` field from a `ComponentType` to this descriptor. It **composes `icon-picker`** (reusing
`extractSvgNodes` for author-time conversion and `SvgIcon` for render), exactly mirroring how
`avatar` is a thin primitive on top of `icon-picker`.

### 1. New plugin — `plugins/apps-core/plugins/app-icon/`

A sub-plugin under the existing `apps-core` umbrella (sibling of `app-rail`, `tab-bar`, `surface`).
Auto-discovered by `./equin build`; no manual registration. It does not import `apps-core`,
so no cycle (apps-core's slot and consumers depend on it, not vice-versa).

```
plugins/apps-core/plugins/app-icon/
  package.json
  core/index.ts                    # the AppIcon type (cross-runtime, serializable)
  web/index.ts                     # barrel: re-exports helpers + empty-contributions default export
  web/internal/app-icon.ts         # mdAppIcon, appIconComponent, DEFAULT_APP_ICON
  web/components/app-icon-view.tsx  # AppIconView
```

**`core/index.ts`** — the canonical serializable descriptor:

```ts
import type { SvgNode } from "@plugins/primitives/plugins/icon-picker/core";

/**
 * Canonical, serializable identity of an app's icon. A discriminated union so a
 * custom-image variant (`{ kind: "image"; src }`) drops in later with one render
 * branch and zero changes to existing `kind: "md"` authors.
 */
export type AppIcon = { kind: "md"; svgNodes: SvgNode[] };
```

- In `core/` so it is cross-runtime importable (consumers + a future server/Tauri reader).
  `core → core` import of `SvgNode` is legal (`@plugins/primitives/plugins/icon-picker/core`).
- `kind` is the explicit seam for the future `image` variant. No `key` field for now (we render
  from `svgNodes`; no picker-highlight/server-backfill need yet, and the author-time `react-icons`
  component exposes no MD name).

**`web/internal/app-icon.ts`** — authoring + adapter:

```ts
import type { ComponentType } from "react";
import type { IconType } from "react-icons";
import { MdWebAsset } from "react-icons/md";
import { extractSvgNodes } from "@plugins/primitives/plugins/icon-picker/web";
import type { AppIcon } from "../../core";

/** Author an app's icon from a tree-shaken react-icons component: `icon: mdAppIcon(MdHome)`. */
export function mdAppIcon(Icon: IconType): AppIcon {
  return { kind: "md", svgNodes: extractSvgNodes(Icon) };
}

/** Fallback for tabs/windows whose owning app can't be resolved. */
export const DEFAULT_APP_ICON: AppIcon = mdAppIcon(MdWebAsset);

/** Adapter: stable `ComponentType` for generic icon-prop boundaries (Tab, IconButton, …). */
const cache = new WeakMap<AppIcon, ComponentType<{ className?: string }>>();
export function appIconComponent(icon: AppIcon): ComponentType<{ className?: string }> { /* WeakMap-memoized AppIconView wrapper */ }
```

**`web/components/app-icon-view.tsx`** — the renderer:

```tsx
import { SvgIcon } from "@plugins/primitives/plugins/icon-picker/web";
export function AppIconView({ icon, className }: { icon: AppIcon; className?: string }) {
  switch (icon.kind) {
    case "md": return <SvgIcon nodes={icon.svgNodes} className={className} />;
  }
}
```

**`web/index.ts`** — barrel re-exporting `mdAppIcon`, `appIconComponent`, `DEFAULT_APP_ICON`,
`AppIconView`, plus `export default { description, contributions: [] }` (a pure-library plugin, like
`icon-picker` itself).

Design notes:
- `mdAppIcon` keeps the existing **tree-shaken** per-app `react-icons/md` import — no 2000-icon
  bundle ships; `extractSvgNodes` (already used per-pick by `IconPicker`) converts the one component
  to serializable nodes once at module load.
- Two render forms because consumers split into two shapes:
  - **Direct render** (`<AppIconView icon={…} className=… />`) — app-rail, home grid, dock.
  - **Component adapter** (`appIconComponent(icon)`) — for generic primitives whose `icon` prop is
    typed `ComponentType<{ className? }>` (`ui/tab-bar` `Tab`/`TabChip`, `IconButton`). The
    `WeakMap` keyed on the stable `AppIcon` object gives a stable component identity (no per-render
    remount). **We do not change those generic primitives' APIs** — they stay glyph-agnostic.

### 2. Slot change — `plugins/apps-core/web/slots.ts`

```ts
import type { AppIcon } from "@plugins/apps-core/plugins/app-icon/core";
// ...
icon: AppIcon;   // was: ComponentType<{ className?: string }>
```

`badge` stays `ComponentType` (it's an overlay, not the canonical icon). `ActiveApp` /
`ResolvedApp` pick this up automatically (both are inferred from the contribution shape).

### 4. Author migration — 13 app barrels (one line each)

`icon: MdHome` → `icon: mdAppIcon(MdHome)`, keeping the existing `react-icons/md` import and adding
`import { mdAppIcon } from "@plugins/apps-core/plugins/app-icon/web"`. Barrels:

`agent-manager` (MdChatBubble), `home` (MdHome), `settings` (MdSettings), `studio` (MdExtension),
`browser` (MdPublic), `debug` (MdBugReport), `pages` (MdDescription), `deploy` (MdCloud),
`sonata` (MdPiano), `workflows` (MdSchema), `prototypes` (MdDashboardCustomize),
`file-explorer` (MdFolder), `story` (MdAutoStories) — all at
`plugins/apps/plugins/<app>/plugins/shell/web/index.ts`.

> Verify `./equin check plugin-boundaries` accepts the nested call `mdAppIcon(MdHome)` inside
> the contribution arg (it is part of the single default-export expression, same shape as the
> existing `Apps.App({…})` call — barrel-purity forbids top-level statements/side-effects, not
> nested value-producing calls). This is the one thing to confirm early.

### 5. Consumer migration — 7 render sites

All consumers import `AppIconView` / `appIconComponent` / `DEFAULT_APP_ICON` from
`@plugins/apps-core/plugins/app-icon/web`.

| Site | File | Change |
|---|---|---|
| App rail | `plugins/apps-core/plugins/app-rail/web/components/app-rail.tsx` | `<app.icon className="size-4"/>` → `<AppIconView icon={app.icon} className="size-4"/>` |
| Home launcher grid | `plugins/apps/plugins/home/plugins/app-cards/web/components/app-grid.tsx` | `icon: <a.icon className="size-7"/>` → `icon: <AppIconView icon={a.icon} className="size-7"/>` |
| Tab bar (docked) | `plugins/apps-core/plugins/tab-bar/web/components/app-tab-bar.tsx` | `icon={app.icon}` (×2: visible + measure strip) → `icon={appIconComponent(app.icon)}` |
| Floating: member rows | `…/surface/plugins/floating/web/components/floating-placement.tsx` | `WindowMember.icon` type `ComponentType` → `AppIcon`; map keeps `icon: app?.icon` |
| Floating: window menu | `…/floating/web/components/window-chrome.tsx` | `const MenuIcon = appIconComponent(activeMember?.icon ?? DEFAULT_APP_ICON)` → `<IconButton icon={MenuIcon}/>` |
| Floating: titlebar tabs | `…/floating/web/components/window-tab-strip.tsx` | `const Icon = appIconComponent(member.icon ?? DEFAULT_APP_ICON)` → `<Tab icon={Icon}/>`; drag-session `icon` type → `AppIcon` |
| Floating: desktop dock | `…/floating/web/components/window-dock.tsx` | `icon={app?.icon ? <AppIconView icon={app.icon}/> : undefined}` |
| Floating: drag ghost | `…/floating/web/components/tab-drag-overlay.tsx` | drag-session `icon: ComponentType` → `AppIcon`; render `appIconComponent(session.icon ?? DEFAULT_APP_ICON)` |

The floating drag-session icon type (set via `startTabDrag(...)` in `window-tab-strip.tsx` and read
in `tab-drag-overlay.tsx`) changes `ComponentType` → `AppIcon` end-to-end; `MdWebAsset` fallbacks
become `DEFAULT_APP_ICON`.

### 6. Docs / scaffolding

- Update `.claude/skills/create-app/SKILL.md` so the app-shell example authors `icon: mdAppIcon(MdXxx)`.
- Update the `Apps.App` slot JSDoc in `slots.ts` to describe `AppIcon`.
- `./equin build` regenerates `apps-core` / per-app `CLAUDE.md` autogen blocks and
  `docs/plugins-*.md`; commit the drift (kept honest by `plugins-doc-in-sync`).

## Files to modify

- **New plugin** `plugins/apps-core/plugins/app-icon/`: `package.json`, `core/index.ts` (`AppIcon`), `web/index.ts` (barrel), `web/internal/app-icon.ts` (`mdAppIcon`, `appIconComponent`, `DEFAULT_APP_ICON`), `web/components/app-icon-view.tsx` (`AppIconView`)
- **Slot:** `plugins/apps-core/web/slots.ts` (import `AppIcon`, retype the `icon` field)
- **13 app barrels** (§4) and **8 consumer files** (§5)
- **Docs:** `.claude/skills/create-app/SKILL.md`; new `plugins/apps-core/plugins/app-icon/CLAUDE.md`

## Reuse (do not reinvent)

- `extractSvgNodes(IconType): SvgNode[]` — `plugins/primitives/plugins/icon-picker/web` — author-time component → serializable nodes.
- `SvgIcon({ nodes, className })` — `plugins/primitives/plugins/icon-picker/web` — render nodes as `<svg>` with no bundle import.
- `SvgNode` — `plugins/primitives/plugins/icon-picker/core`.
- Precedent to mirror byte-for-byte: `avatar` (`AvatarSpec { svgNodes }` + `<SvgIcon>`), `DEFAULT_AGENT_AVATAR`.

## Verification

1. `./equin build` — TypeScript fails loudly on any of the 13 barrels or 8 consumers not
   migrated (the slot type change propagates through `ActiveApp`/`ResolvedApp`). Then
   `./equin check` (boundaries, `plugins-doc-in-sync`, type-check).
2. Visual at `http://att-1782684524-gvca.localhost:9000` via `e2e/screenshot.mjs` — confirm icons
   render in: **app rail** (far-left strip), **Home launcher grid** (`/home`), **docked tab bar**,
   and a **floating window** (titlebar menu/tabs + desktop dock) by switching a tab to floating
   placement. Each should be pixel-equivalent to today (same MD glyphs).
3. Spot-check serializability: `JSON.stringify(mdAppIcon(MdHome))` yields a plain `{kind,svgNodes}`
   object — the property a future favicon/Tauri reader consumes.

## Future (explicitly deferred — format is designed for it)

- `{ kind: "image"; src: string }` variant + an `AppIconView` branch → custom/uploaded images.
- Runtime per-app override persisted in DB (avatar-style), layered over the declared default.
- Feed the descriptor into favicon (`<link rel="icon">`) and desktop/Tauri per-app packaging.
