# Browser App — Vision & Implementation Spec

A **minimal web browser** as a top-level Singularity app (`/browser`, globe icon).

## Vision

Singularity runs inside a real browser, so the "browser app" is necessarily an
**iframe-based webview**. We embrace that constraint *honestly*:

- Render embeddable pages inside an `<iframe>`.
- Many sites block framing (`X-Frame-Options` / CSP `frame-ancestors`). We do
  **not** fake detection of this — instead we always offer a prominent
  **"Open in new tab ↗"** affordance so any page is one click from the real
  browser, and the start page carries a one-line note explaining the limitation.

It feels like a real browser: an omnibox (URL or search), back/forward/reload/home
navigation, persisted bookmarks with a bookmarks bar, browsing history, and a
start page (recents + bookmarks + quick links).

### Honest non-goals (v1)
- No server-side proxy to strip frame headers (would make blocked sites embed).
  Filed as a follow-up — it's the real "make it useful" feature but is a
  significant, security-sensitive piece (HTML rewriting, SSRF, cookies).
- No in-app tab strip — the platform's own surface tabs let you open multiple
  browser instances. Filed as a follow-up.
- No favicon mirroring infra — we use a single `<img>` to Google's favicon
  service with a globe fallback (degrades offline).

## Architecture

`plugins/apps/plugins/browser/` (empty namespace) with sub-plugins:

| Plugin | Runtime | Responsibility |
|---|---|---|
| `shell` | web | App entry, layout, **per-surface navigation store**, slot definitions, `<Favicon>` |
| `navigation` | web | Back / forward / reload / home buttons |
| `omnibox` | web | Address bar: URL normalization + search fallback |
| `webview` | web | The `<iframe>` viewport, loading bar, "Open in new tab", empty→start-page |
| `bookmarks` | web+server | DB-persisted bookmarks: star toggle + bookmarks bar |
| `history` | web+server | DB-persisted visits: headless recorder + recents resource |
| `start-page` | web | Empty-state landing: hero, quick links, bookmarks, recents |

### Navigation store (owned by `shell`, exported from its web barrel)

Per-surface via `defineScopedStore` (each surface tab = isolated instance).

```ts
type BrowserNavState = {
  history: string[];   // visited URLs; "" sentinel = start page
  index: number;       // pointer into history (current = history[index])
  loadKey: number;     // bump to force iframe reload
  loading: boolean;    // true between navigate/reload and iframe onLoad
};
// initial: { history: [""], index: 0, loadKey: 0, loading: false }
```

Shell exports a `useBrowserNav()` hook returning:
```ts
{
  current: string;            // history[index]; "" => start page
  canGoBack: boolean; canGoForward: boolean;
  loading: boolean; loadKey: number;
  navigate(url: string): void;  // truncate forward, push, index=end, loading=true
                                // if url === current => reload() instead
  back(): void; forward(): void;
  reload(): void;             // loadKey++, loading=true
  goHome(): void;             // navigate("")
  finishLoad(): void;         // loading=false (called by webview onLoad)
}
```
The store is dumb (no IO, no normalization). Callers pass fully-formed URLs.

### Slots (defined in `shell/web/slots.ts`, all `defineRenderSlot`)

Every item shape is `{ id: string; component: ComponentType }`; render with
`{(item) => <item.component />}`. Order = registration order (reorder primitive
handles user reordering automatically).

| Slot | Contributor(s) | Where rendered |
|---|---|---|
| `Browser.NavControls` | navigation | leading, in chrome bar |
| `Browser.Omnibox` | omnibox | center (flex-1), in chrome bar |
| `Browser.Actions` | webview (open-external), bookmarks (star) | trailing, in chrome bar |
| `Browser.SubBar` | bookmarks (bookmarks bar) | second row; renders nothing when empty |
| `Browser.Viewport` | webview (only) | main content area |
| `Browser.StartPage` | start-page | rendered by webview when `current === ""` |
| `Browser.Effects` | history (recorder) | headless; use `defineMountSlot` |

### Layout (shell, hand-composed — needs two chrome rows, so not `AppShellLayout`)

```
<BrowserNav.Provider>            // per-surface store
  <div flex-col h-full bg-background>
    <Bar tier="chrome">
      <NavControls.Render/>      // leading buttons
      <div flex-1 min-w-0><Omnibox.Render/></div>
      <Actions.Render/>          // trailing
    </Bar>
    <SubBar.Render/>             // bookmarks bar (its own <Bar tier="pane">), or nothing
    <main flex-1 min-h-0 overflow-hidden>
      <Viewport.Render/>         // webview
    </main>
    <Effects.Mount/>             // headless history recorder
  </div>
</BrowserNav.Provider>
```
> Note: the component that mounts `<BrowserNav.Provider>` cannot read the store
> in its own body — put the bars in an inner `<BrowserInner/>` component.

### webview behavior
- If `current === ""` → render `<Browser.StartPage.Render/>`.
- Else render `<iframe key={`${loadKey}:${current}`} src={current}
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups
  allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
  onLoad={finishLoad}/>`.
- Thin indeterminate **top progress bar** while `loading`.
- Contributes an **Open-in-new-tab** `IconButton` (`MdOpenInNew`) to
  `Browser.Actions`, disabled when `current === ""`; `window.open(current,
  "_blank", "noopener,noreferrer")`.

### omnibox behavior
- Controlled input; sync local value to `current` when `current` changes.
- `MdSearch`/globe leading affordance, Enter submits.
- `normalizeInput(raw)`:
  - trim; empty → `goHome()`.
  - `^https?://` → as-is.
  - host is `localhost`/`127.*`/`*.localhost` → prefix `http://`.
  - looks like a domain (has `.`, no spaces) → prefix `https://`.
  - else → search `https://duckduckgo.com/?q=<encoded>`.

### bookmarks (server + web)
- Table `browser_bookmarks`: `{ id text pk, url text, title text, createdAt ts default now }`.
- Live resource `browser-bookmarks` → `[{ id, url, title }]`, ordered by `createdAt asc`.
- Endpoints: `POST /api/browser/bookmarks` `{url,title}`; `DELETE /api/browser/bookmarks/:id`.
- **Star** action (`Browser.Actions`): `MdStar`/`MdStarBorder` toggling the current
  url; disabled when `current === ""`. title = hostname of url.
- **Bookmarks bar** (`Browser.SubBar`): a `<Bar tier="pane">` of chips
  (`<Favicon> + hostname`) that `navigate(url)` on click, hover-reveal remove (×).
  Renders nothing when there are no bookmarks (no empty chrome row).

### history (server + web)
- Table `browser_history`: `{ id text pk, url text, title text, visitedAt ts default now }`.
- Live resource `browser-recents` → most-recent **distinct-by-url** visits, limit ~12,
  `[{ url, title, visitedAt }]`.
- Endpoint: `POST /api/browser/history` `{url}` (records a visit; title = hostname).
- **Recorder** (`Browser.Effects`, headless): `useEffect` on `current` change →
  if non-empty, fire the record mutation. Returns `null`.

### start-page (web; depends on shell + bookmarks + history barrels)
Rendered in the viewport when no URL is loaded:
- Centered hero: app name + a large primary "search/enter URL" affordance that
  focuses the omnibox (or its own input that calls `navigate`).
- **Quick links**: a small curated default set of framing-friendly sites
  (e.g. example.com, Hacker News, MDN) as `<Favicon>` tiles → `navigate`.
- **Bookmarks** grid (from `browser-bookmarks` resource) when present.
- **Recently visited** (from `browser-recents` resource) when present.
- One-line muted note: "Some sites block embedding — use ↗ to open them in a new tab."
- Use css primitives only (`Grid`, `Stack`, `Inset`, `Text`, `Surface`, `Row`/`Card`).

## Build order (waves)
1. `shell` + `navigation` + `omnibox` + `webview` (interactive core, no DB) → build.
2. `bookmarks` ∥ `history` (both depend only on shell) → build.
3. `start-page` (depends on bookmarks + history) → build → verify → push.

## Conventions (must follow)
- Plugin ids are path-derived; never author `id:` in barrels.
- Barrel purity: only imports, own-file re-exports, type aliases, single
  `export default {…} satisfies PluginDefinition/ServerPluginDefinition`.
- Cross-plugin imports only via runtime barrels (`@plugins/.../web|server|core`).
  Never import another plugin's `shared/`.
- All spacing/typography/radius/color via css primitives — no ad-hoc Tailwind
  (`gap-*`, `p-*`, `text-*`, `rounded-*`, raw z-index) — lint will fail.
- Components live in `web/components/`, not inline in `index.ts`.
- Never run `drizzle-kit`/migrations manually; `./equin build` regenerates.
- Do NOT edit `*.generated.ts` registries — build regenerates them.
