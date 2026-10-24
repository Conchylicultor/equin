# Per-Mode (Light/Dark) Token Editing in the Theme Customizer

## Context

Token overrides currently write the same value to both light and dark modes. The data model already stores overrides as `{ light?: Record<string,string>, dark?: Record<string,string> }` and `ThemeInjector` already merges them independently — only the UI layer needs changes.

**Goal:** Let users edit light and dark token values independently via a pane-level mode selector.

## Design

A **segmented control** (Both | Light | Dark) sits between the global preset picker and the search bar.

- **Both** (default): current behavior — single value, writes to both modes
- **Light**: shows resolved light-mode values, edits only `overrides.light[key]`
- **Dark**: shows resolved dark-mode values, edits only `overrides.dark[key]`, toggles page to dark mode for live preview

**Split indicator:** tokens whose light/dark overrides differ show a small half-circle dot (left=white, right=black) next to the undo button.

**Dark-mode coupling:** switching to Dark toggles `.dark` on `<html>`; switching to Light removes it. On pane close, the original state is restored.

## Implementation Steps

### 1. Create `TokenModeContext`

**New file:** `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/internal/token-mode-context.ts`

```ts
export type TokenMode = "both" | "light" | "dark";
export const TokenModeContext = createContext<TokenMode>("both");
```

Export from `theme-customizer/web/index.ts`. Follows the same pattern as `ColorAdjustContext`.

### 2. Add mode selector and context provider in `ThemeCustomizerBody`

**File:** `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx`

- Add `const [tokenMode, setTokenMode] = useState<TokenMode>("both")`
- Render a 3-segment `TokenModeSelector` component between `GlobalPresetPicker` and `SearchInput`
- Wrap `<ThemeCustomizer.Host>` in `<TokenModeContext.Provider value={tokenMode}>`
- Add `useEffect` that toggles `document.documentElement.classList` when `tokenMode` changes
- Add mount/unmount effect that saves and restores the original dark state

### 3. Add `isSplit` prop to `TokenRow`

**File:** `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/token-row.tsx`

- Add optional `isSplit?: boolean` prop
- When true, render a split-circle indicator (CSS `linear-gradient(to right, white 50%, black 50%)`) before the undo button

### 4. Update section components to be mode-aware

**Pattern (apply to each color section):**

```ts
const tokenMode = useContext(TokenModeContext);

// Resolve both sets
const lightValues = transformValues({ ...active.light, ...(overrides.light ?? {}) }, adjustment);
const darkValues = transformValues({ ...active.dark, ...(overrides.dark ?? {}) }, adjustment);

// Pick active set based on mode
const activeValues = tokenMode === "dark" ? darkValues : lightValues;
const activeOverrideKeys = new Set(
  Object.keys(tokenMode === "dark" ? (overrides.dark ?? {}) : (overrides.light ?? {}))
);

// Split detection
const isSplit = (key: string) => {
  const lo = overrides.light?.[key];
  const dk = overrides.dark?.[key];
  return lo !== dk && (lo !== undefined || dk !== undefined);
};
```

Update `setOverride`/`resetOverride` to branch on `mode: TokenMode`:
- `"both"` → write/delete from both `light` and `dark`
- `"light"` → write/delete from `light` only
- `"dark"` → write/delete from `dark` only

**Affected section files:**
- `plugins/ui/plugins/tokens/plugins/color-palette/web/components/color-palette-section.tsx`
- `plugins/ui/plugins/tokens/plugins/sidebar-palette/web/components/sidebar-palette-section.tsx`
- `plugins/ui/plugins/tokens/plugins/chart/web/components/chart-section.tsx`
- `plugins/ui/plugins/tokens/plugins/shape/web/components/shape-section.tsx` (setOverride/resetOverride only)
- `plugins/ui/plugins/tokens/plugins/typography/web/components/typography-section.tsx` (setOverride/resetOverride only)

**Shadow section is untouched** — its `writeParams` always writes identical light/dark values (mode-independent by design).

### 5. Update barrel export

**File:** `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/index.ts`

Add: `export { TokenModeContext, type TokenMode } from "./internal/token-mode-context";`

## Files Modified

| File | Change |
|------|--------|
| `theme-customizer/web/internal/token-mode-context.ts` | **New** — type + context |
| `theme-customizer/web/components/theme-customizer.tsx` | Mode selector, context provider, dark-mode effects |
| `theme-customizer/web/components/token-row.tsx` | `isSplit` prop + indicator |
| `theme-customizer/web/index.ts` | Export context |
| `color-palette/web/components/color-palette-section.tsx` | Mode-aware values + override helpers |
| `sidebar-palette/web/components/sidebar-palette-section.tsx` | Same |
| `chart/web/components/chart-section.tsx` | Same |
| `shape/web/components/shape-section.tsx` | Override helpers only |
| `typography/web/components/typography-section.tsx` | Override helpers only |

## Verification

1. `./equin build` — builds and deploys
2. Open `http://<worktree>.localhost:9000`, navigate to theme customizer pane
3. Test "Both" mode — editing a color token applies to both (existing behavior preserved)
4. Switch to "Dark" — page goes dark, color swatches show dark-mode values
5. Edit a token in Dark mode — only dark override is written; switch to Light and confirm the light value is unchanged
6. Confirm split indicator appears on tokens where light ≠ dark
7. Close pane — page appearance reverts to whatever it was before
8. Test undo: in Light mode, undo resets only light override; in Both mode, resets both
