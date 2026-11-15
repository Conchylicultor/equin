# Token groups (and quick-theme) no longer ride on the theme customizer

Task: task-1794675956-br0mef (follow-up of task-1794673447-w9tkvj, the equin.ai
unregistered-group burst). User decision: "choose the clean design".

## Context

Every `ui/tokens/<group>` web barrel contributes its `ThemeEngine.TokenGroup`
(painting data) AND a `ThemeCustomizer.Section` (editor UI), so it statically
imports `theme-engine/theme-customizer/web` plus every primitive its editor
uses (collapsible, color-picker, row, loading…). The web loader isolates
plugins one by one (`web-sdk/core/loader.ts`: `Promise.allSettled` over each
plugin's `import()`), but a static import chains a plugin's fate to its
imports: when the customizer artifact (or anything only it reaches) fails to
fetch or evaluate, no token group registers. The same coupling exists for the
quick-theme popover: `theme-gallery` (theme picker) and `theme-toggle`
(light/dark) contribute their `QuickTheme.Section` from the same barrel as a
`ThemeCustomizer.Section`, `tweakcn/community-browser` its `ThemeSource` with
one, and `quick-theme` itself imports `themeCustomizerRoute` from the
customizer's web barrel for its footer link.

## Decision: option A — the editor half is its own child plugin

Each mixed plugin keeps its painting / quick-theme contributions and moves its
customizer section to a child `<plugin>/plugins/customizer` (web only).

Why A over B (a lazily imported section declared as data on the token group):

- **The loader already gives exactly the isolation we want** — per plugin. A
  plugin boundary is the existing unit of "this can fail alone"; B re-creates
  it inside one plugin with a dynamic import, Suspense and a contract change.
- **B puts an editor concept into theme-engine's `TokenGroup` contract** (the
  painter would carry a reference to UI it never draws), and still does not
  cover `theme-gallery` / `theme-toggle` / `community-browser`, whose sections
  are not token groups.
- **A also removes the editor's whole dependency fan-out** (color-picker,
  collapsible, …) from the registration path, not just the customizer barrel;
  a parent now imports theme-engine and its own core only.
- **A is checkable statically** with the import graph (below); a dynamic
  import is a much weaker property to enforce.

The cost — ~21 small plugins — is mechanical.

## Changes

1. **18 token groups** (`categorical`, `chart`, `chord-palette`,
   `color-palette`, `data-view`, `density`, `file-type-palette`, `font-family`,
   `icons`, `material`, `overlay`, `place-palette`, `scrollbar`, `shadow`,
   `shape`, `sidebar-metrics`, `sidebar-palette`, `type-scale`): parent
   `web/index.ts` keeps `ThemeEngine.TokenGroup` (+ font-family's `Core.Root`
   slot, icons' `Icons.Root` bridge); `web/components/*-section*`,
   `*-header-dots`, `shortcuts.ts` move to `plugins/customizer/web/`, whose
   barrel contributes the `ThemeCustomizer.Section`.
   (`color-adjust` is a pure customizer plugin; `rich-text-palette` has no
   section; `color-ref` has no web — unchanged.)
2. **theme-gallery**: `ThemeCustomizer.Section` + `ThemeGalleryPicker` /
   `SelectedThemeSummary` / item actions move to `theme-gallery/plugins/customizer`;
   the quick picker stays. Shared picker internals the two need are exported
   from the parent web barrel.
3. **theme-toggle**: `ColorModeSection` → `theme-toggle/plugins/customizer`.
4. **tweakcn/community-browser**: `ImportByUrlSection` →
   `community-browser/plugins/customizer`.
5. **quick-theme's link**: `themeCustomizerRoute` moves to
   `theme-customizer/core` (`defineRoute` is from `pane/core`), so quick-theme
   reaches only the customizer's tiny core module, never its web barrel.
6. **Enforcement** — check `theme-customizer:painting-off-the-editor` in
   `theme-customizer/check/`: for every web plugin contributing to a
   theme-engine painting slot (`token-group`, `theme`, `sub-theme`,
   `fixed-theme`, `theme-source`, `variant-group`) or to `QuickTheme.Section`
   (read with codegen's `collectWebSlotContributions`, generic — no contributor
   named), the static import closure of its web barrel
   (`fileSetImportClosures`, dynamic imports cut) holds no module under
   `theme-customizer/web/`; failures print the shortest import chain.
7. Docs: `ui/tokens/CLAUDE.md` prose (three jobs → registration + a
   `customizer` child), theme-customizer CLAUDE.md note on the check.

## Verification

- `./equin check theme-customizer:painting-off-the-editor` passes; temporarily
  re-adding a customizer import to a token group barrel makes it fail.
- `./equin build`, `./equin check`, tests of touched plugins
  (`icons/web/__tests__`).
- Browser on own build: customizer pane still lists every section; quick-theme
  popover shows the theme picker and light/dark. Then block the customizer's
  web artifact (route-intercept the request in the browser session) and reload:
  token-group CSS vars (e.g. `--shadow-md`, scrollbar) still painted, quick-theme
  picker + light/dark still render; only the customizer sections are missing.

## Addendum (implementation)

- **The children ship as companions.** Nothing imports a `customizer` child, so
  outside main's `**` a composition would ship the customizer pane without
  them (found in review: the demo kept 2 of 22 sections).
  `defineDetailSections` gained a `companions: true` option (passed to
  `defineRenderSlot`), `ThemeCustomizer` opens it, every section contributes
  `companion: true`, and the slots facet reads a companion-opened
  `defineDetailSections` call as its `<Group>.Section` slot (only those: naming
  every detail pane would add soft edges to every composition). Pinned in
  `closure.test.ts`.
- **Verified in the browser** with the customizer's web module made to throw on
  evaluation (the built chunk rewritten in flight): token groups still painted
  (shadow, tooltip/overlay, scrollbar vars), the quick-theme popover still shows
  the theme picker, Appearance switches and variants; only the customizer and
  Settings › Appearance (which imports it) fail to load.
- **Caveat — chunks.** Since the 2026-11-14 route-chunk bundler, boot modules
  are packed into size-split chunks, so a chunk that fails to *fetch* takes
  every module in it, whatever plugin owns them. The split guarantees the
  module level (evaluation failures, and which chunk group code lands in), not
  the chunk packing.
