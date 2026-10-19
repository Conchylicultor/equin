# Server-painted first-frame theme (delete the localStorage theme cache)

Track: *Draft and local storage* (page `block-9a32de2c-5e30-42d5-862e-df4b8ee96b24`), step **[Theme]**.

## Context

To paint the right theme on frame 0, theme-engine copies the resolved theme CSS into
`localStorage["theme-engine:critical-css"]`. The aggregator in
`theme-engine/web/internal/{paint-cache-aggregator,theme-cache}.ts` writes it, and the inline
script in `framework/web-core/web/index.html` replays it. The cache once grew to 7 MB, filled
the site's ~10 MB localStorage, and silently broke every other plugin's writes. Commit
`2a8f687f76` made it content-addressed and capped it, but it is still a large browser-side copy.
It is also empty on every new browser or private window, which means a flash of the neutral
floor there.

**Exit for this step:** the first frame paints the right theme without any browser storage, and
the cache, its replay and its budget are deleted.

## End state

**The server renders the theme, and the HTML it serves already carries it.**

1. **One renderer.** A pure function in `theme-engine/core` turns *(theme declarations + stored
   themes + selection config + root app)* into the exact `<style id>` map that ThemeInjector
   mounts. The browser (live repaint, customizer preview) and the server both call it, so the two
   produce the same bytes by construction.
2. **Declarations reach the server through the sanctioned bridge.** Token groups, code themes,
   sub-themes, fixed themes and the app list (`id`, `basePath`) stay declared once, as the web
   slot contributions they are today, so the ~34 contributors don't change. A build codegen reads
   them the way `token-group-vars-gen.ts` already does (`importBarrel`, generic on slot id). It
   emits a serialized data registry the server imports, guarded by an `*-in-sync` check. Every
   input is plain data. A token-group descriptor's `fragment` builder is not needed to render;
   only `id` / `schema` / `vars` are.
3. **Stored themes reach the renderer through a server source slot**, mirroring the web
   `ThemeEngine.Source` "resident" kind. saved-themes contributes `list()` and a change signal,
   so theme-engine never names saved-themes.
4. **The gateway stays theme-agnostic.** A small generic "document head" server primitive
   accepts per-path head fragments from owners and writes them atomically to a per-worktree file.
   The gateway splices the longest-prefix match into `index.html` before `</head>`. The backend
   writes the file, so a cold or swept backend never delays the page. The prestart already boots
   the backend, and its recompute fixes the next load.
5. **The browser keeps nothing.** ThemeInjector adopts the served `<style>` elements by id
   (unchanged ids, so the adoption code stays as it is). index.html keeps only the storage-free
   cold floor (OS dark → `.dark`).

**Later, not this step:** the browser could stop re-rendering and read the server's CSS as a live
value, leaving client rendering only for the customizer's preview. That would delete the web-side
declaration registry, and is a separate track item if wanted.

## Implementation

### 1. Pure renderer → `theme-engine/core`
- Move `web/internal/serialize-vars.ts` (`renderGroupBlock`, `buildVarsBlock`) and
  `web/internal/transform.ts` (`transformValues`, `transformOklch`) into `core/`. Both are pure.
- Move the pure scope-selector helpers `themeScopeSelectors`, `appThemeScope`, `fixedThemeScope`
  and `subThemeScope` from `ui-kit/web/components/portal-theme-scope.tsx` into a `core/` barrel.
  ui-kit or theme-engine core, whichever the boundary table allows from both. Update the web call
  sites; no re-exports.
- New `core/render-paint.ts`, `renderPaint({ groups, themes, subThemes, fixedThemes, selections,
  rootAppId | null })`, returns `{ styles: Record<styleId, css>, mode }`, covering the four style
  families (`theme-engine-<group>`, `theme-scope-app:<id>-<group>`, `theme-scope-sub:…`,
  `theme-scope-fixed:…`). It reuses `resolveTheme`, `resolveFixedTheme`, `subThemeBlockValues`,
  `mergeGroupValues` and `assertComplete` (moved out of `theme-injector.tsx`).
- ThemeInjector's `GroupStyle`, `AppScopeThemes`, `SubThemeStyles` and `FixedThemeStyles` call
  the same per-block functions, so the client output stays byte-identical. A core test pins the
  output for a fixture.

### 2. Declaration bridge (codegen)
- New `codegen/core/theme-declarations-gen.ts`, modeled on `token-group-vars-gen.ts`. It
  collects contributions to the slots `ui.theme-engine.token-group | theme | sub-theme |
  fixed-theme` and `apps-core`'s `Apps.App` (only `app.id` and `app.basePath`). It writes
  `theme-engine/core/theme-declarations.generated.ts` (plain data) and registers it in the build
  codegen step, plus a `theme-declarations-in-sync` check. If the boundary table refuses a
  framework→ui target, the generated file location follows the `token-group-vars` precedent.

### 3. Server: source slot, materializer
- `theme-engine/server`: a server slot `ThemeEngine.Source` with `{ id, list(): Promise<Theme[]>,
  onChange(cb) }`. saved-themes/server contributes it, using `listSavedThemes()` and its write
  paths. Prefer an existing change signal (change-feed or live-value invalidation) over a
  hand-rolled emitter.
- A materializer computes one entry per app that has its own theme document
  (`getConfigScopeIds(themeSelectionConfig)` → `app:<id>` → basePath from the registry) plus the
  `""` global entry. Apps without a document match `""`, which is identical content. Each entry
  becomes a head fragment: the `<style id>` elements, plus a tiny inline script setting
  `.dark` from the configured mode (`system` → `matchMedia`). It recomputes on boot, on
  `watchConfig(themeSelectionConfig)` (including added or removed scopes) and on a source change,
  coalesced with `packages/coalesce`. A failure throws and is reported. It never writes an empty
  fragment that looks like success.

### 4. Generic document-head primitive + gateway
- A new small server plugin (proposed `plugins/shell/plugins/document-head`): `publishHeadFragments(owner,
  { [pathPrefix]: html })` merges owners and atomically writes
  `~/.singularity/worktrees/<wt>/document-head.json` (path from `infra/paths` data-dirs).
- `gateway/proxy.go` `serveIndex`: when the file exists, read it (cached by mtime), longest-prefix
  match `r.URL.Path` (canonicalize `//+` like `normalizeRoutePath`; `""` fallback), and splice
  before `</head>`. Serve with `http.ServeContent`, with an ETag derived from the
  index.html mtime and the fragment hash, keeping `no-cache` so a theme change is a 200 and an
  unchanged page is still a 304. Go tests cover match, fallback, missing file and ETag variation.
- Check `web-artifacts/compose.ts`'s graph hash of the source `index.html` still behaves; the
  inline script shrinks, which is a one-time hash change.

### 5. Delete the cache
- Delete `theme-cache.ts`, `paint-cache-aggregator.ts`, its test, `usePaintedStyle` /
  `setPaintContext` / claim-prune wiring in `theme-injector.tsx`, and `CACHE_BUDGET`.
- `index.html`: drop the replay. Keep the cold-floor script (OS scheme → `.dark`), so a page with no
  fragment still paints the right shade.
- One-time cleanup: ThemeInjector calls `localStorage.removeItem("theme-engine:critical-css")`
  once (try/catch-free removeItem; it doesn't throw on quota) to free the 1 MB left behind. Note it
  for removal in the storage-primitive step.
- Docs: `.claude/skills/theme/SKILL.md` (cache section), `ui-kit/web/theme/CLAUDE.md`
  (warm/cold path), `theme-engine/CLAUDE.md`, the gateway `CLAUDE.md` (shell splice), and the
  storage inventory sub-page (entry removed).

## Risks / decisions
- **HTML weight.** One entry is about 200 KB of CSS, the same bytes the cache replayed, now inline.
  Caddy compresses on deployed hosts. If it matters, a follow-up trims the `theme-scope-app:*`
  blocks of non-root apps from the fragment (they are not needed for frame 0).
- **Staleness.** A theme changed while no backend runs (an agent editing `theme.jsonc`) is stale
  for one frame on the next load, then corrected by ThemeInjector and by the prestarted backend's
  recompute. That is no worse than today, and new browsers improve.
- **Desktop / windows surface** roots the global theme. The path → app match for an app URL is the
  same assumption the cache made.

## Verification
- `./singularity test plugins/ui/plugins/theme-engine` (renderer parity fixture, materializer),
  `go test ./gateway/...` (splice).
- `./singularity check` (new in-sync check, boundaries, `plugins-doc-in-sync`).
- `./singularity build`, then with the `browser_*` MCP tools on a fresh tab: `curl` the shell for
  `/home`, `/agents` and `/` and confirm each carries its own `<style id="theme-engine-color-palette">` and
  the right mode. Load `/home` with localStorage cleared and screenshot before hydration (JS
  disabled, or `screenshot.ts --wait 0`): it shows the home theme. Change the home app's theme in
  the customizer, reload, and confirm frame 0 has the new theme. Confirm
  `localStorage["theme-engine:critical-css"]` is absent.
- Track page: tick **[Theme]**, update Status, and file the next main task (**[Drafts]**: server-stored drafts).
