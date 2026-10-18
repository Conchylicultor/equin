# Overlay material: frosted-glass menus as a theme choice

## Context

The Desktop mockup (`proto-1792144948-0pxmsf`, `.menu` in `styles.css`) draws every menu as frosted glass:
`background: var(--menu-bg)` (`#fcfcfd` at 90%) + `backdrop-filter: blur(30px) saturate(1.8)`.
In the app, the window system menu, shelf app menu, launcher app menu and wallpaper context menu are all
`CursorAnchoredMenu` → `DropdownMenuContent` → `OverlayPanel` → `SURFACE_LEVELS.overlay`
(`plugins/primitives/plugins/css/plugins/ui-kit/web/theme/surface.ts`), which paints an opaque `bg-popover`.
Nothing in that chain lets a theme say "my overlays are glass". So the desktop open-codes the material at
each site (`shelf-popover.tsx:67` `bg-popover/90 backdrop-blur-[30px] backdrop-saturate-[1.8]`,
`launcher-panel.tsx:146` and `switcher-overlay.tsx:140` `bg-popover/90 backdrop-blur-2xl backdrop-saturate-180`).
The `bg-popover/90` spelling also slips past `surface/no-adhoc-surface`, whose overlay fingerprint matches only
`^bg-popover$`. The desktop theme's own comment (`desktop/plugins/shell/web/internal/theme.ts`) records the
current stance: "translucency is not spelled here, each surface applies its own alpha".

Outcome: the overlay role's **material** (fill and backdrop filter) becomes two theme tokens. The overlay bundle
reads them. The desktop theme sets them once, and every overlay opened in the `app:desktop` scope becomes glass.
That covers menus, popovers, selects, dialogs and `<Surface level="overlay">`. Portaled popups already carry
`data-theme-scope` on their Positioner (`usePortalForwardedAttrs`), and `window-system-menu.tsx` wraps itself in
`PopupTheme name={desktopThemeScope}`, so scoped tokens reach them with no plumbing. All other themes keep the
defaults, so they change nothing.

## Design

### 1. Two tokens: `popover-fill` and `popover-backdrop` (new group `ui/tokens/plugins/material`)

```ts
export const materialGroup = defineTokenGroup("material", {
  // A floating panel's fill (the overlay role's background). Default = the
  // opaque popover tone it always wore; a glass theme mixes it with transparent.
  "popover-fill":     { default: "var(--popover)", label: "Popover fill" },
  // What a floating panel does to what shows through it (a CSS backdrop-filter).
  // Default `none`; a glass theme sets e.g. `blur(30px) saturate(1.8)`.
  "popover-backdrop": { default: "none",           label: "Popover backdrop" },
});
```

- **Why a separate fill token, not a translucent `--popover`:** `--popover` also paints things that must stay
  opaque over scrolled content. Examples are `OverlayPanel`'s sticky header (`bg-popover`), `SelectContent`'s
  sticky header and scroll buttons, and the overlay's `--chrome-mask`. A translucent `--popover` would make those
  see-through. Keeping `--popover` opaque also keeps the "palette stays opaque" invariant every color group expects.
- **Why a new group and not color-palette:** the backdrop filter is not a colour, and the fill only makes sense
  paired with it. "Material" is the role they share, and later tokens can join it, such as a dock or sheet
  material. The layout copies `tokens/plugins/shadow`: `core/group.ts`, `core/index.ts`, and a
  `web/components/material-section.tsx` registered as a `ThemeEngine.TokenGroup` and a `ThemeCustomizer.Section`.

### 2. Utilities and the overlay bundle

`ui-kit/web/theme/app.css` gets two utilities, next to `rounded-popover` and `shadow-popover`. They are spelled
out, with `twmerge: extend` annotations, so a caller's `bg-*` or `backdrop-*` override still replaces them:

```css
@utility bg-popover-fill { background-color: var(--popover-fill); }          /* twmerge: extend bg */
@utility backdrop-popover { -webkit-backdrop-filter: var(--popover-backdrop);
                            backdrop-filter: var(--popover-backdrop); }      /* twmerge: extend backdrop-filter */
```

The exact twmerge group names come from the existing annotation mechanism, which the build reads into
`custom-utilities.generated.ts`.

`SURFACE_LEVELS.overlay`: `bg-popover` → `bg-popover-fill backdrop-popover`, and the comment is updated. Every
`OverlayPanel` consumer picks this up: dropdown and sub-menus, popover, select, dialog and `FloatingSurface`.
`TooltipContent` is not included. The mockup's tooltips are a different, dark material, so tooltips stay out of
scope.

### 3. Close the lint loophole (`plugins/primitives/plugins/css/plugins/surface/lint/no-adhoc-surface.ts`)

The overlay fingerprint's background matcher becomes `^bg-popover(-fill)?(\/\d+)?$`, and a `backdrop-blur*`
token joins it as an alternative fingerprint. An open-coded glass overlay (`bg-popover/90` + blur + shadow +
rounded) then gets flagged and pointed at `<Surface level="overlay">`. A lint test case covers both spellings.

### 4. Desktop theme sets the material (`plugins/apps/plugins/desktop/plugins/shell/web/internal/theme.ts`)

```ts
/** The mockup's frosted menu glass (`--menu-bg` + blur 30 saturate 1.8). */
const material = materialGroup.fragment(both({
  "popover-fill": "color-mix(in oklab, var(--popover) 90%, transparent)",
  "popover-backdrop": "blur(30px) saturate(1.8)",
}));
```

Add it to `fragments`, and rewrite the "translucency is not spelled here" paragraph: the overlay material is now
spelled in the theme, and only the dock keeps its own alpha.

### 5. Delete the desktop's open-coded copies

- `launcher-panel.tsx:146` and `switcher-overlay.tsx:140` are already `<Surface level="overlay">`, so their
  `bg-popover/90 backdrop-blur-2xl backdrop-saturate-180` is dropped and they inherit the material. The mockup
  blurs these two panels 40px rather than 30px, which is an imperceptible difference at 90% fill. Keeping one
  material is worth it.
- `shelf-popover.tsx` is a hand-rolled `div` carrying the overlay recipe. It becomes `<Surface level="overlay">`
  (the `className` keeps positioning, animation and its bespoke shadow), so its glass comes from the token too.
- `shelf.tsx:223` is the dock, `bg-background/55`. It is a different material (`--dock-bg`) and is left as is,
  out of scope.

## Critical files

- new `plugins/ui/plugins/tokens/plugins/material/{core,web}`, modelled on `plugins/ui/plugins/tokens/plugins/shadow`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/surface.ts`, `.../ui-kit/web/theme/app.css`
- `plugins/primitives/plugins/css/plugins/surface/lint/no-adhoc-surface.ts` (+ its test)
- `plugins/apps/plugins/desktop/plugins/shell/web/internal/theme.ts`
- `plugins/apps/plugins/desktop/plugins/{launcher,switcher,shelf}/web/components/*`

## Out of scope / follow-ups

- `overlay/plugins/floating-action` `variant="glass"` and `image-viewer/viewer-chrome.tsx` `bg-popover/80
  backdrop-blur-md` are other hand-rolled glass. They may migrate to the material later, as a follow-up task.
- Tooltip material, the dock material, and the mockup's 10px menu radius and menu shadow.

## Verification

1. `./singularity build`. This regenerates the docs and utilities and runs the checks: type-check, eslint with
   the updated `no-adhoc-surface`, and `plugins-doc-in-sync`.
2. `./singularity test plugins/primitives/plugins/css/plugins/surface plugins/ui/plugins/theme-engine`.
3. Drive `/desktop` with the `browser_*` MCP tools:
   - right-click a window titlebar, a shelf app and the wallpaper, and open the launcher's app menu;
   - for each menu, `browser_javascript` should report `getComputedStyle(panel).backdropFilter` =
     `blur(30px) saturate(1.8)` and a translucent background;
   - take a screenshot over a busy wallpaper and compare it to the mockup's menu.
4. Regression: open a dropdown in a non-desktop app, such as the agent manager. It should still be opaque with
   `backdrop-filter: none`.
