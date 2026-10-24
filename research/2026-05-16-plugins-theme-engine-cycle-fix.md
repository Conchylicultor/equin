# Fix theme-engine / theme-customizer circular dependency

## Context

`variant-settings.tsx` (in `theme-engine/web`) has a "Customize" button that
navigates to the theme-customizer pane. It can't import `themeCustomizerPane`
because that creates a cycle:

```
theme-engine/web → theme-customizer/web (pane ref)
theme-customizer/web → theme-engine/web (ThemeEngine slots)
```

The current workaround is a raw `pushState` + synthetic `popstate` hack that
bypasses the pane API entirely.

**Root cause:** `theme-engine` is both the API provider (slots, CSS injection)
and a UI consumer (Config.Section that links to the child pane). The fix is to
separate these concerns: `theme-engine` becomes pure plumbing, `theme-customizer`
owns all user-facing UI.

## Plan

### Before / After

```
BEFORE:
  theme-engine/web     → slots + ThemeInjector (Core.Root) + VariantSettings (Config.Section)
  theme-customizer/web → pane + full editor

AFTER:
  theme-engine/web     → slots + ThemeInjector (Core.Root) only
  theme-customizer/web → pane + full editor + VariantSettings (Config.Section) + Shell.Sidebar
```

Dependency after: `theme-customizer → theme-engine` only. No reverse edge.

### Step 1 — Move `VariantSettings` into theme-customizer

**Add** `VariantSettings` to `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx`.

Take the component from `variant-settings.tsx` but fix the Customize button:

```tsx
// BEFORE (pushState hack):
onClick={() => {
  const url = `${getBasePath()}/theme-customizer`;
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}}

// AFTER (proper API):
onClick={() => openPane(themeCustomizerPane, {}, { mode: "root" })}
```

New imports needed in this file: `openPane` from `@plugins/primitives/plugins/pane/web`,
`MdTune` from `react-icons/md`. Everything else (`ThemeEngine`, `themeEngineConfig`,
`useConfigValues`, `setConfigValue`) is already imported.

**Deduplicate `GlobalPresetPicker`**: both files have near-identical copies.
Keep the existing one in `theme-customizer.tsx` (it already has `flex-wrap`)
and reuse it from the new `VariantSettings`. No separate extraction needed —
both components are in the same file.

### Step 2 — Update theme-customizer barrel

**Edit** `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/index.ts`:

- Add imports: `Config` from config, `Shell` from shell, `sidebarNavItem`
  from app-shell, `openPane` from pane, `MdPalette` from react-icons/md,
  `VariantSettings` from `./components/theme-customizer`
- Add contributions:
  ```ts
  Config.Section({
    id: "ui-variants",
    title: "UI Themes",
    description: "Choose the global theme and visual variant for each pluggable component.",
    component: VariantSettings,
  }),
  Shell.Sidebar({
    id: "theme-customizer",
    ...sidebarNavItem({
      title: "Theme",
      icon: MdPalette,
      onClick: () => openPane(themeCustomizerPane, {}, { mode: "root" }),
    }),
  }),
  ```

### Step 3 — Strip Config.Section from theme-engine barrel

**Edit** `plugins/ui/plugins/theme-engine/web/index.ts`:

- Remove `import { Config } from "@plugins/config/web"`
- Remove `import { VariantSettings } from "./components/variant-settings"`
- Remove the `Config.Section(...)` entry from contributions
- Keep `Core.Root({ component: ThemeInjector })` as the only contribution
- All exports stay unchanged (`ThemeEngine`, slot types, `ThemeScope`,
  `ColorAdjustContext`, `transformValues`)

### Step 4 — Delete `variant-settings.tsx`

**Delete** `plugins/ui/plugins/theme-engine/web/components/variant-settings.tsx`.

No external consumers — only the barrel imported it.

### What stays unchanged

- `theme-engine/core/` — `defineTokenGroup`, `themeEngineConfig`, types
- `theme-engine/server/` — `Config.Field(themeEngineConfig)`
- `theme-engine/web/slots.ts` — all 4 slot definitions
- `theme-engine/web/components/theme-injector.tsx` — `Core.Root` component
- `theme-engine/web/components/theme-scope.tsx` — `ThemeScope` wrapper
- `theme-engine/web/internal/transform.ts` — oklch transform utils
- All external slot contributors (chart, color-palette, shadow, etc.)
- `theme-customizer/web/panes.tsx`, `slots.ts`, `token-row.tsx`

## Files to modify

| File | Action |
|------|--------|
| `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx` | Add `VariantSettings`, add `openPane`/`MdTune` imports |
| `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/index.ts` | Add `Config.Section`, `Shell.Sidebar`, import `VariantSettings` |
| `plugins/ui/plugins/theme-engine/web/index.ts` | Remove `Config.Section`, remove `Config`/`VariantSettings` imports |
| `plugins/ui/plugins/theme-engine/web/components/variant-settings.tsx` | Delete |

## Verification

```bash
./equin build        # must pass all checks including plugin-boundaries, boundary-rules, no cycles
```

Then verify in the browser at `http://<worktree>.localhost:9000`:

1. **Settings pane**: "UI Themes" section still appears with preset picker + Customize button
2. **Customize button**: click opens the Theme Customizer pane (proper navigation, not pushState)
3. **Sidebar**: "Theme" entry visible, click opens Theme Customizer pane
4. **Theme Customizer pane**: full editor works (preset picker, search, token sections)
