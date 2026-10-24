# Floating desktop wallpaper

## Context

The floating-window surface placement (`plugins/apps/plugins/surface/plugins/floating/`)
renders draggable windows over a "desktop". Today that desktop is a purely
decorative, theme-driven SVG gradient (`web/components/desktop-wallpaper.tsx`),
deliberately `pointer-events-none` / `aria-hidden` — the plugin's CLAUDE.md
documents a "passive backdrop" invariant (no desktop icons, shortcuts, or
context menus).

We want the user to **right-click the desktop → set an image as wallpaper**,
sourced from an **open-license image database (Openverse)** plus **upload** and
**paste-URL**. Image sources must be a **pluggable provider registry**
(collection-consumer pattern) so future providers drop in with zero edits to the
picker. The chosen wallpaper persists **globally** (not per-app): the floating
desktop renders against the global `:root` theme — `floatingDef` has no
`themeScope`, unlike docked/solo — so the wallpaper is a property of the desktop
itself, one setting shared across apps and worktrees.

Confirmed decisions:
- **Image source:** Openverse first, as a self-contained provider contribution.
- **Other sources:** upload my own image, paste an image URL.
- **Persistence:** global `config_v2` (no `scope: "app"`).
- **Storage:** all chosen images are **mirrored locally** (server downloads via
  SSRF-guarded `safeFetch`, validates, stores in a machine-global wallpaper
  store, serves same-origin). Config holds only metadata + attribution.
- **Attribution:** small unobtrusive corner credit on the desktop (CC-BY
  compliance) linking to the source.
- This **revises the passive-backdrop invariant** to allow a desktop context
  menu — an intentional, documented design change.

## Architecture

New plugin tree under the floating placement:

```
plugins/apps/plugins/surface/plugins/floating/plugins/wallpaper/   # parent: slot, config, picker, menu, endpoints, store
  ├── plugins/openverse/      # provider: Openverse CC search
  ├── plugins/upload/         # provider: local file upload
  └── plugins/from-url/       # provider: paste an image URL
```

### Dependency direction (DAG — no cycles)

- `wallpaper/core` — config descriptor + types + endpoint contracts. No deps.
- `wallpaper/server` — provider registry, endpoint impls, on-disk store, `ConfigV2.Register`.
- `wallpaper/web` — provider slot, picker dialog, desktop context menu, save helpers, shared search panel, `ConfigV2.WebRegister`.
- `floating/web` → imports `wallpaper/core` (read config in backdrop) + `wallpaper/web` (mount context-menu + attribution layers). **floating depends on wallpaper.**
- providers → import `wallpaper/core` + `wallpaper/web`. **providers depend on wallpaper.**
- `wallpaper` imports **nothing** from `floating`. Graph: `floating → wallpaper ← providers`.

### The provider abstraction (collection-consumer)

Each source is a uniform contribution — a tabbed panel that produces a *candidate*:

```ts
// wallpaper/web/slots.ts
export const Wallpaper = {
  Provider: defineSlot<{
    id: string;
    label: string;
    icon?: IconType;
    Panel: ComponentType<{ onPick: (candidate: WallpaperCandidate) => void }>;
  }>("floating.wallpaper-provider", { docLabel: (p) => p.label }),
};
```

```ts
// wallpaper/core
export type WallpaperCandidate =
  | { kind: "remote"; url: string; attribution?: WallpaperAttribution }
  | { kind: "file"; file: File; attribution?: WallpaperAttribution };

export type WallpaperAttribution = {
  creator?: string; license?: string; licenseUrl?: string;
  sourceUrl?: string; title?: string;
};
```

Pattern mirrors `Sonata.Source`
(`plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` + its `midi` contributor
+ generic `useContributions()` read in `.../shell/web/context.tsx`). The picker
calls `Wallpaper.Provider.useContributions()` and renders one tab per provider —
never naming a specific provider. The picker centralizes saving: on `onPick`, it
funnels the candidate through the server save path, writes config, closes.

### Search dispatch (server-side, generic)

Openverse search runs server-side (CORS + `safeFetch` consistency). A single
generic endpoint dispatches to a server-side provider registry keyed by id:

```ts
// wallpaper/core/endpoints.ts
export const searchWallpaper = defineEndpoint({
  route: "GET /api/wallpaper/search",
  query: z.object({ provider: z.string(), q: z.string().min(1).max(200) }),
  response: z.array(WallpaperResultSchema), // { id, thumbUrl, fullUrl, attribution }
});
```

```ts
// wallpaper/server — registry à la defineHistorySource / defineAssetMirror
const registry = new Map<string, WallpaperSearchProvider>();
export function defineWallpaperProvider(p: WallpaperSearchProvider): WallpaperSearchProvider & Registration {
  return { ...p, register() { registry.set(p.id, p); } };
}
// handler: registry.get(query.provider)?.search(query.q) → results
```

The `openverse` sub-plugin contributes `defineWallpaperProvider({ id: "openverse", search })`
on the server (via `register: [...]`) and `Wallpaper.Provider({ id: "openverse", ... })`
on the web. Its web Panel reuses a shared `WallpaperSearchPanel` (exported from
`wallpaper/web`) parameterized by `providerId="openverse"`, which calls
`useEndpoint(searchWallpaper, { provider, q })` and renders results in a `Grid`.

### Local mirror store + save endpoints

All chosen images become local files served same-origin. Machine-global store at
`~/.singularity/wallpaper/` (precedent: `asset-mirror`, `secrets` live under
`~/.singularity/`). Two save endpoints:

```ts
// import a remote URL (Openverse pick OR pasted URL)
export const importWallpaperUrl = defineEndpoint({
  route: "POST /api/wallpaper/import-url",
  body: z.object({ url: z.string().url(), attribution: WallpaperAttributionSchema.optional() }),
  response: SavedWallpaperSchema, // { version, mime }
});
// upload a local file
export const uploadWallpaper = defineEndpoint({
  route: "POST /api/wallpaper/upload",
  body: multipart(),
  response: SavedWallpaperSchema,
});
```

`import-url` handler: `parsePublicUrl(url)` → `safeFetch(url)` → assert
`content-type` starts with `image/`, enforce a max-byte cap → write bytes to the
store → bump `version`. `upload` handler: validate the `File` is an image → write
to the store. Error convention mirrors `page/bookmark/server/internal/scrape.ts`
(catch `SsrfError`/network `TypeError`/`AbortError` → `HttpError`; rethrow
unexpected). Serve the current image at `GET /api/wallpaper/image?v=<version>`
streaming `Bun.file(...)` (cache-bust on `version`). Not using the `attachments`
primitive: the orphan-sweep would reclaim an unlinked wallpaper, and there is no
owner entity for a single global setting — a dedicated singleton store is the
clean fit.

### Global config

```ts
// wallpaper/core/config.ts — NOTE: no `scope: "app"` → global
export const wallpaperConfig = defineConfig({
  name: "wallpaper",
  fields: {
    state: objectField({
      label: "Desktop wallpaper",
      subFields: {
        kind: enumField({ options: ["default", "image"], default: "default" }),
        version: intField({ default: 0 }),       // cache-bust + image presence
        mime: textField({ default: "" }),
        attribution: objectField({ subFields: {
          creator: textField(), license: textField(), licenseUrl: textField(),
          sourceUrl: textField(), title: textField(),
        }}),
      },
    }),
  },
});
```

Registered both server (`ConfigV2.Register`) and web (`ConfigV2.WebRegister`) —
the web registration is **required** for boot hydration (precedent:
`plugins/debug/plugins/slow-ops/{server,web}/index.ts`). The picker writes via
`useSetConfig(wallpaperConfig)` with no `scopeId` (global). "Reset to default"
sets `kind: "default"`.

## Files

### New — `floating/plugins/wallpaper/`
- `core/config.ts` — `wallpaperConfig` (global), attribution/result/saved schemas.
- `core/endpoints.ts` — `searchWallpaper`, `importWallpaperUrl`, `uploadWallpaper` contracts; `WallpaperCandidate`/`WallpaperAttribution` types.
- `core/index.ts` — barrel.
- `server/internal/registry.ts` — `defineWallpaperProvider` + `getWallpaperProvider`.
- `server/internal/store.ts` — `~/.singularity/wallpaper/` read/write + `GET image` streamer.
- `server/internal/handle-{search,import-url,upload,image}.ts` — endpoint impls (`safeFetch` in import-url).
- `server/index.ts` — `httpRoutes` + `ConfigV2.Register`.
- `web/slots.ts` — `Wallpaper.Provider` slot.
- `web/components/wallpaper-picker.tsx` — `openWallpaperPicker()` (via `openDialog`); tabs from `useContributions()`; centralized save (`fetchEndpoint(import-url|upload)` → `setConfig`).
- `web/components/wallpaper-search-panel.tsx` — shared `WallpaperSearchPanel` (`SearchInput` + `useEndpoint(searchWallpaper)` + `Grid`).
- `web/components/desktop-context-menu.tsx` — transparent contextmenu-capture layer; `DropdownMenu` anchored at cursor x,y (pattern from `window-system-menu.tsx`): "Change wallpaper…" + "Reset to default" (when image set).
- `web/components/wallpaper-attribution.tsx` — small corner credit chip (reads config, links `sourceUrl`).
- `web/internal/save.ts` — helpers shared by picker/providers.
- `web/index.ts` — `ConfigV2.WebRegister` + mount contributions.

### New — providers
- `wallpaper/plugins/openverse/server/index.ts` — `register: [defineWallpaperProvider({ id: "openverse", search })]` (`safeFetch` → `https://api.openverse.org/v1/images/?q=...`, map to results; no API key for basic use).
- `wallpaper/plugins/openverse/web/index.ts` — `Wallpaper.Provider({ id: "openverse", label: "Openverse", icon, Panel: () => <WallpaperSearchPanel providerId="openverse" .../> })`.
- `wallpaper/plugins/upload/web/index.ts` — `Wallpaper.Provider({ id: "upload", ..., Panel: UploadPanel })` (file input → `onPick({ kind: "file", file })`).
- `wallpaper/plugins/from-url/web/index.ts` — `Wallpaper.Provider({ id: "from-url", ..., Panel: UrlPanel })` (URL input → `onPick({ kind: "remote", url })`; server validates on save).

### Modified — `floating/`
- `web/components/desktop-wallpaper.tsx` — `useConfig(wallpaperConfig)`; if `kind === "image"` render `<img src={GET /api/wallpaper/image?v=version} class="absolute inset-0 size-full object-cover">`, else the existing gradient SVG (renamed `DefaultGradientBackdrop`).
- `web/components/floating-foreground.tsx` (or the backdrop mount in `surface-body.tsx`) — mount `<DesktopContextMenu/>` (lowest z, below windows so windows keep their own right-click) + `<WallpaperAttribution/>` (corner).
- `CLAUDE.md` — revise the "passive backdrop" invariant to permit the desktop context menu + wallpaper image.

## Key reuse (existing utilities)

- Contribution slot + generic read: `defineSlot` / `.useContributions()` (`@plugins/framework/plugins/web-sdk/core`) — pattern from `Sonata.Source`.
- Server registry token: `Registration` + `register: []` pattern from `defineHistorySource` (`plugins/history/plugins/engine/server/internal/registry.ts`).
- Endpoints: `defineEndpoint` / `implement` / `useEndpoint` / `fetchEndpoint` / `multipart()` / `HttpError` (`@plugins/infra/plugins/endpoints/{core,server,web}`).
- SSRF-guarded fetch: `safeFetch` / `parsePublicUrl` / `SsrfError` (`@plugins/infra/plugins/safe-fetch/server`) — consumption pattern from `page/bookmark/server/internal/scrape.ts`.
- Global config: `defineConfig` (no scope) + `ConfigV2.Register` + `ConfigV2.WebRegister` + `useConfig`/`useSetConfig` (`@plugins/config_v2/{core,server,web}`) — precedent `debug/slow-ops`.
- Field factories: `objectField` / `enumField` / `textField` / `intField` (`@plugins/fields/plugins/{object,enum,text,int}/plugins/config/core`).
- UI: `DropdownMenu*` (cursor-anchored, from `window-system-menu.tsx`), `openDialog` (`@plugins/primitives/plugins/imperative-dialog/web`), `SearchInput` (`@plugins/primitives/plugins/search/web`), `Grid` (`@plugins/primitives/plugins/css/plugins/grid/web`).

## Verification

1. `./equin build` from the worktree (regenerates migrations/registry/docs;
   runs checks incl. `plugin-boundaries`, `plugins-registry-in-sync`,
   `plugins-doc-in-sync`, `type-check`).
2. Open `http://att-1782307207-vtot.localhost:9000`, put a tab into **Float as
   window** (so the desktop renders).
3. **Right-click empty desktop** → menu appears → "Change wallpaper…".
4. Picker: **Openverse** tab → search (e.g. "mountains") → grid of CC results →
   click one → desktop updates; corner attribution credit shows creator + license
   linking to source.
5. **Upload** tab → pick a local image → desktop updates. **Paste URL** tab →
   paste an image URL → desktop updates; paste a non-image / private URL →
   graceful error (no crash), wallpaper unchanged.
6. Reload the page (and a *different* worktree's desktop) → wallpaper persists
   (global config). Right-click → "Reset to default" → gradient SVG returns.
7. Scripted check with `e2e/screenshot.mjs` (`--click "Change wallpaper…"`) for a
   before/after capture.
8. Confirm right-clicking a *window titlebar* still shows the window system menu
   (desktop menu only fires on empty desktop).

## Out of scope / follow-ups

- Additional providers (Wikimedia Commons, Unsplash/Pexels behind `auth` API keys)
  — drop-in new sub-plugins, no picker edits.
- Surfacing the wallpaper control in Appearance/theme settings as a second entry
  point (the desktop is the global theme; could live beside it later).
- Per-app or per-workspace wallpapers (current scope: one global desktop wallpaper).
