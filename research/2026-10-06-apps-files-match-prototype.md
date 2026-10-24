# Files app ⇄ prototype proto-1790864772-0r54

## Context

The File Explorer app (`plugins/apps/plugins/file-explorer`, route `/files`) has drifted from its agreed mock, proto-1790864772-0r54. The user reviewed every difference, and the mock now has no variants, so it is the spec. The target is a pixel match in light and dark, at 1440×900 and at the mock's breakpoints (1100 / 900 / 640). The diff list is in the task. This plan says where each item lands. The rule is: **per-app look goes in a Files app theme (tokens). Structural gaps get a generic, opt-in primitive capability. Nothing hard-codes "file-explorer" in a shared primitive.**

Mock reference values: `~/.singularity/apps/prototypes/proto-1790864772-0r54/index.html`, `:root` blocks lines 18-54.

## 1. Lucide as an icon family (the big structural piece)

Today `ui/icons` only knows Material: `IconStyle = {shape, fill, activeFill, weight}`, a closed `StyleKey` set, and sprites built from the Iconify Material sets (`plugins/ui/plugins/icons/core/style.ts`, `plugins/sprites/server/internal/{sprites,build-sprite,resolve-icon}.ts`).

**Approach (chosen by the user): a `family` axis on the theme scope's icon style, so every `symbol("…")` drawn inside a Lucide scope draws its Lucide counterpart.** That covers the app's own buttons and also the shared chrome inside Files (sidebar toggle, path-bar pencil, SearchInput's magnifier, preview Close, the folder icon in FileTypeIcon). A Files-only `lucide("…")` ref kind could not reach that chrome.

- **`core/style.ts`**
  - `IconStyle` gains `family: "material" | "lucide"` (default `material`).
  - Lucide has no shape/fill/weight, so it gets one sprite key, `lucide`. `SpriteKey` widens to include it, alongside `brands` / `seti`. `styleKeyOf` returns `lucide` for a lucide-family style.
  - Id: `lucide-<materialName>`. The symbol keeps the *Material* name as its id, so `<Icon>` needs no name translation.
- **Name map**
  - `core/lucide-map.ts` is a closed `Partial<Record<SymbolName, LucideName>>`, e.g. `arrow-back → chevron-left` is NOT mapped. The app switches to `symbol("chevron-left")` / `chevron-right`, as agreed. The map holds `folder → folder`, `folder-open → folder-open`, `home → house`, `download → download`, `hard-drive → hard-drive`, `delete → trash-2`, `open-in-new → external-link`, `close → x`, `search → search`, `edit → pencil`, `left-panel-*` → `panel-left`, `visibility-off → eye-off`, `visibility → eye`, `chevron-right`, `arrow-upward → arrow-up`, and so on.
  - The sprite builder resolves `lucide-<name>` through the map. An unmapped name falls back to the Material drawing in the default style. That is visible and not silent, because the `icons:lucide-coverage` check (below) lists it.
- **Tuning is baked at sprite build** (`build-sprite.ts`), so every use is identical.
  - Wrap the Lucide body in `<g transform="translate(1.5 1.5) scale(.875)">`, which puts the glyph at 7/8 of the 24-unit box (14px in a 16px slot).
  - Force `stroke-width="1.2"` with `vector-effect="non-scaling-stroke"`, giving a rendered ~1.2px stroke at any size. This matches the mock's `sw·0.85 ≈ 1.19px`.
  - A normalizer version goes into the sprite hash.
- **Data:** add `@iconify-json/lucide` to the root `package.json`, embedded via `icon-sets.js`/`.d.ts` like the Material sets. It is non-resident (fetched on demand through `wantSprite`, as Seti is). Extend the manifest's covered names. No new scanner pattern is needed, because names are still `symbol("…")`.
- **Token:** the icons token group (`plugins/ui/plugins/tokens/plugins/icons/core/group.ts`) gains `iconFamily` (material | lucide). Wire it through `readIconTokens`, `IconsSection` (customizer segmented control), `IconThemeBridge`, and the `style-store.ts` equality.
- **Check:** `icons:lucide-coverage` fails when a symbol used in a file under a plugin whose app theme selects Lucide has no map entry. If scoping that statically proves brittle, it fails on any manifest symbol without an entry *and* without an explicit `material-only` marker in the map. Pick at implementation, but it must fail loudly, not warn.

## 2. Files theme and name

- **Name:** `defineApp({ name: "Files" })` in `plugins/apps/plugins/file-explorer/plugins/shell/core/app.ts`. The rail, tab and sidebar brand all read `app.name`. Update the shell `CLAUDE.md` and the e2e strings that assert the name. The id stays `file-explorer`.
- **Brand header:** the outline folder in #1f5a7c with no tile. Pass a `mark` on the Apps.App entry (`LauncherMark` already prefers `app.mark`). The mark draws `symbol("folder")`, which is Lucide in this scope. If the shared `size-6` header form keeps the glyph off the mock's 16px and 8px gap, add a generic `markSize` on the brand rather than an app special case.
- **Theme:** `plugins/apps/plugins/file-explorer/plugins/shell/web/internal/theme.ts`, `defineTheme({ id: "files", label: "Files", … })`, follows the `pagesInkTheme` / `equinTheme` pattern with full light and dark fragments. It is contributed with `ThemeEngine.Theme` in the shell `web/index.ts` and selected by `config/ui/theme-engine/@app/file-explorer/theme.jsonc`, which copies the format of the existing `@app/*/theme.jsonc` files.
  - **colorPalette**, from the mock's `--surface/--line/--text/--muted/--faint/--accent*`:
    - background #fff / #18181b
    - foreground #18181b / #ededef
    - mutedForeground #5f5f68 / #a1a1aa
    - faintForeground #9a9aa3 / #6b6b73
    - border #e4e4e7 / #2a2a2e
    - primary and ring #2563eb / #3b82f6
    - accent (hover) rgb(0 0 0/.04) / rgb(255 255 255/.05)
    - selected #e6eefd / #1c2b47
    - muted (fill) #f3f3f5 / #222225
  - **sidebarPalette:** sidebar #f3f3f5 / #111113, sidebarAccent = hover, sidebarPrimary = accent.
  - **sidebarMetrics:** panel width 14rem (224px), row height 28px, icon gap 10px, pad per the mock's `14px 10px`.
  - **density:**
    - `chromePaneH` 48px (toolbar and preview header)
    - `treeRowH` set so rows measure 30px
    - `treeIndent` 18px, which is the guide width
    - the rule colour/width as the mock's `--line-soft` hairline
  - **typeScale:** body 13px, caption 12px, group/meta 11px, title for the preview sub-theme.
  - **shape:** radius 6px.
  - **icons:** `iconFamily: "lucide"`.
  - **fileTypePalette:** folder #3b82f6 / #60a5fa, if the group carries the folder tone.
- **Tree disclosure:** `config/ui/tree-disclosure/@app/file-explorer/tree-disclosure.jsonc` changes `column` → `merged`, the existing variant. The `Expand` label the e2e relies on is unchanged.

## 3. Generic primitive capabilities (opt-in, theme-neutral)

These are needed because tokens alone can't express them:

1. **Selected-row foreground.**
   - The `color-palette` group gains `selectedForeground`. Its default is `inherit` semantics (`var(--foreground)`), so other apps don't change.
   - `TreeRowChrome`'s selected state sets a `--row-fg` / `--row-meta` pair, and the tree's `AlignedCells` read it. Name, date and size all take the accent text colour (#1d4fd0 / #93bbfd) when selected.
2. **Indent guides.**
   - `TreeRowChrome` / the data-view tree view gain `guides?: boolean`, drawn as one hairline per ancestor level at `treeIndent` pitch, with the guide line in `border`-soft.
   - Files turns it on in `file-tree.tsx`. Pages etc. are untouched.
3. **SearchInput `appearance="filled"`**: a grey `muted` fill, no border, `radius`, and an accent border on focus. File Explorer's Filter uses it at 180px, or 132px with a file open (the mock's widths).
4. **Breadcrumb fold.** The trail folds into "…" with room to spare. Reproduce it in the deployed app first, then fix the measurement in `breadcrumb/web/internal/use-ancestor-collapse.ts` / the `PathBar` crumb `Stack`. The suspicion is that the trail root doesn't fill, so the ResizeObserver never sees new room. This is a shared bug fix: verify the other `Breadcrumb` consumers. PathBar passes `text="body"`, and a new `leafWeight="semibold"` gives the 13px semibold current folder.
5. **Seti glyphs fill their box.** Crop each Seti symbol's viewBox to the glyph's bounding box when vendoring (`plugins/ui/plugins/icons/shared/seti.ts` `normalizeSetiSvg`, bump `SETI_NORMALIZER_VERSION`, re-run `scripts/vendor-seti.ts`). The mapping (README → info, package.json → npm) is untouched. **This is a global change to every Seti icon.** The user chose this over a Files-only scale.

## 4. App-local changes (file-explorer only)

- **Places sidebar** (`places/web/components/places-sidebar.tsx`)
  - Section heads use `SectionsToolbar` `forms.header: "group"` (sentence case, 11px faint, tight). The heading tone comes from the theme's `groupForeground` = faint.
  - Rows are muted text, foreground on hover and active, weight 500 when active, and the active row's leading icon is `text-primary`.
- **Storage meter** (`storage-meter.tsx`): reads "190 GB free of 500 GB" (the bar still shows the used fraction), inset 18px, 11px faint text, 4px bar.
- **Toolbar** (`browser/web/components/file-browser.tsx`)
  - Icons: `chevron-left` / `chevron-right` / `arrow-upward`.
  - Filter `appearance="filled"`.
  - Keep the sidebar toggle and the show-hidden button. Their order is per the mock: toggle, back, fwd, up, path, filter, hidden.
- **Tree** (`file-tree.tsx`)
  - Modified `align: "start"`, 12px muted; Size `align: "end"`.
  - Column widths 96 / 80, header 11px faint.
  - `guides`.
  - FileTypeIcon in an 18px box (the mock's `.ibox`).
  - The open file stays semibold. Folder size is "—" until listed, which is already the case.
- **Status bar:** left side only (`N items · “name” selected`, 11px faint). Drop the `hostFsVolume` "available" read.
- **Preview header** (`preview-pane.tsx`)
  - Icon 20px, name 13px semibold, meta 11px faint.
  - Renderer tabs as the mock's pill chips, then Open with default app, then Close. There is no ⋯.
  - The markdown body wears a **Files document sub-theme** (`defineSubTheme`, as `equinDocumentTheme` does) for h1 24px, body 14px/1.6.
  - The 28px / 32px padding is a padding prop on `MarkdownView` (file-viewer markdown), defaulting to today's values.
- **Responsive**, matching the mock's media queries:
  - ≤1100px: sidebar 200px.
  - ≤900px with a file open: sidebar hidden, Filter hidden, Modified column hidden.
  - ≤640px: sidebar hidden; a file open replaces the listing.
  - Done with container/viewport classes in the layout and tree, plus `sidebarPanelWidth` via a breakpoint in the theme if tokens allow; otherwise a layout class.

## 5. Verification

1. Run `./equin build` (backgrounded), then `./equin check`.
2. Run `compare-diff.ts --name proto-1790864772-0r54` at the default width, at each canvas preset that brackets 1100 / 900 / 640, and in light and dark (`--color-scheme`). Iterate on token values until the differing-pixel ratio is near zero; content differences (real filesystem vs mock data) are the only residue. Use the colour report to tune palette tokens.
3. Run `explorer-verify.ts`, extended with assertions for: the app name "Files" in the brand, sidebar width 224, toolbar 48, row height 30, Modified left-aligned, the selected row's colour = accent text, guides present under an expanded folder, the status bar having no "available", and the breadcrumb showing every ancestor at 1440. Also run `git-verify.ts`.
4. Screenshot other apps that use the touched primitives (Pages tree, agent-manager sidebar, a transcript markdown, a file pane with Seti icons) to confirm nothing changed except, if chosen, the global Seti crop.
5. Run `./equin test` on `ui/icons`, `primitives/breadcrumb` and `primitives/tree`.
