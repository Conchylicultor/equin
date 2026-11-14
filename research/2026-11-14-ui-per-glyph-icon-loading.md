# Icons: download what a page draws, glyph by glyph

Task: "Icon sprites are 481 KB on a cold load and one icon change invalidates
the whole set" (task-1794614991-5a7sth).

## Context — measured on main, 2026-11-14

| Page | Icons drawn (distinct) | Sprite markup the page holds |
|---|---|---|
| `/agents` (main) | 25: 47 inline agent-family glyphs, 8 Lucide, 2 saved names (×2 styles), 1 Material | **1.37 MB**: resident Material outline+filled 270 KB (768 symbols), saved-icon asset 197 KB (219 names × 2 styles), Lucide + Lucide-active 384 KB (746 symbols), rounded outline+filled 407 KB (768 symbols), brands 4 KB |
| `/about` (equin.ai) | 13 (12 Material + github) | resident 270 KB + saved 58 KB (76 names × 2) + brands 4 KB — **84 KB gzip on the wire** |

Why so big — the cost splits into:

1. **Resident sprites = the whole build manifest** (384 Material names, every
   `symbol("…")` literal in the repo) in the default style's two fills. A page
   draws 1–12 of them. A code-closure manifest would not help: main eagerly
   preloads 1,534 artifacts whose code names 464 icons — i.e. all of them; the
   website composition's /about closure still names 134.
2. **The saved-icon asset = every name every saved-icon source reports**
   (agents, callouts, tags, places…), in both default fills — not the ones the
   page shows (2 on /agents).
3. **Other styles and Lucide are whole sprites on demand** (`icons.sprite`),
   and every on-demand live value is served and fetched `no-store` (the
   live-state cache-poisoning rule), so they re-download on every load
   (task-1794587905-jlnskq). One Lucide icon fetches 746 symbols.
4. **Invalidation is all-or-nothing**: one hash per set — a new icon anywhere
   moves `icons.sprite-hash` and re-downloads every sprite; one picked avatar
   moves the saved asset's ETag.

What a page needs is a function of what it *draws*, which only the render
knows. So the unit must be the glyph, asked for by the render.

## Design

### 1. Every Material glyph is a per-name glyph (code and saved alike)

`SymbolName` and `SavedSymbolName` are the same name list (`saved-names`'
`symbol-names.json`), and `icons.runtime-symbols` already draws any of them in
any style, batched per frame per style (`createRuntimeSymbolLoader`,
content-addressed `{ hash, key, names }`). So a code `symbol("…")` drawn in
Material is asked for exactly like a saved icon: `resolveIconDrawing`'s
`symbol` arm wants `(styleKey, name)` from a runtime store, and draws the
default style's glyph while the wanted style loads (same fallback as today).

- Code symbols always come from the **page's** store (`pageRuntimeSymbols`),
  even inside a plugin scope: a scope's server is a browser host whose Material
  drawer would load the 1.3 MB bundled set for a name it has not cached. (Today
  they came from the page's resident sprites — same server.) Saved icons keep
  their scope's store.
- The resident `default-*` sprites, the rounded/sharp/light whole sprites and
  the saved-icon asset are gone. `icons.sprite` keeps the brands (6 glyphs,
  resident from the head) and Seti (on demand, file views only).
- A name the drawer cannot draw is answered without its symbol: the store marks
  it **missing** (the crossed-out marker, reported) instead of a refusal that
  takes the sheet down.

### 2. Lucide (and its active forms) per glyph

New value `icons.family-glyphs` `{ hash, key: lucide | lucide-active, names }`
(immutable, on demand): the subset of the drawer's memoized sprite whose ids the
names map to. A family-glyph store (page-global, like the sprite store — the
drawing is the same whichever server drew it) holds chunks; wants route through
the runtime store the icon is in (page → page loader, scope → scope's server,
as `wantSprite` did).

### 3. The first frame waits for its glyphs (no pop-in)

`<Icon>` asks for its wants in a **layout** effect. The sprite host, in the
layout effect of its first commit (the app's first commit), hides the document
(`visibility: hidden` on `<html>`), and in its passive effect — after every
layout effect of that commit, so every first-frame want is recorded — awaits
"the page's stores hold every want" and shows it. Bounded: past 3 s it shows
anyway and reports. A boot span (`icon-first-frame`) records the wait.

### 4. Warm loads: 0 RTT, cached for good, O(changes)

- A raw asset `GET /api/icons/glyph-assets/:hash/:key/:names` (immutable,
  `public, max-age=31536000`) answers the same markup as a batch.
- After the first frame, the page remembers (localStorage, per app base path)
  the batches the first frame used: the ones the head provided plus the new
  ones. Bounded (oldest dropped past 400 glyphs).
- The head's inline script reads that memory and fetches those assets at t0
  (browser cache hits); the boot task provides them before the first render,
  so a warm first frame wants nothing and the gate opens at once.
- A changed first frame (a new icon) adds ONE small batch; nothing already
  cached is re-downloaded. A hash change (new icon sets/build version) 409s and
  falls back to the gated fetch.

Cold first visit: the first frame's glyphs (≈13–25, a few KB) in one RTT after
the app renders, instead of 84–250 KB gzip competing with the code from t0.

## Files

- `plugins/ui/plugins/icons/web/internal/icon-drawing.ts` — `symbol` arm wants
  runtime glyphs from the page store; Lucide via family-glyph store.
- `…/web/internal/runtime-symbol-store.ts` — missing names, `whenIdle()`,
  family-glyph wants.
- `…/web/internal/icon.tsx`, `icon-markup.ts` — layout-effect wants.
- `…/plugins/sprites/core/sprites.ts` — `familyGlyphs`, `getGlyphAsset`; drop
  `getSavedSpriteAsset`; `RESIDENT_SPRITE_KEYS = [brands]`.
- `…/plugins/sprites/server/internal/*` — family-glyph value, glyph asset, head
  script, runtime-symbols answer missing names.
- `…/plugins/sprites/web/internal/{boot,sprite-host}.ts(x)` — head memory,
  first-frame gate.

## Verification

- `./equin test plugins/ui/plugins/icons`.
- Build; on `/agents` and the website `/about`: count drawn icons vs symbols in
  the sheet, bytes of `/api/icons/*` + `/api/resources/icons.*` cold and warm,
  no `ms-default-*` sprite, no `<use>` of an unheld id after first paint;
  first-paint timing cold (throttled) before/after.

## Results (2026-11-14, local gateway — uncompressed, headless Chromium)

Icon payload = every `/api/icons/*` + `/api/resources/icons.*` response body.
"warm" = second load in the same browser, "warm2" = third. Website before =
`website.att-1794614758-l5s3ex` (main-equivalent), after = this checkout's
website composition. Profiles: fast 4G = 9 Mbps / 60 ms + 4× CPU, slow 4G =
1.6 Mbps / 150 ms + 4× CPU. Medians of 3 runs (2 for `/agents` fast 4G).

| Page / profile | icon bytes cold | warm | warm2 | symbols in page | content commit (+gate) cold | LCP cold |
|---|---|---|---|---|---|---|
| `/about` fast 4G, before | 334 KB (4 req) | 0.2 KB | 0.2 KB | 926 | 18.8 s | 19.2 s |
| `/about` fast 4G, after | 11–18 KB (3–5 req) | 6.5 KB | 0 | 25 | 18.1 s (+0.36) | 18.9 s |
| `/about` slow 4G, before | 334 KB | 0.2 KB | 0.2 KB | 926 | 37.7 s | 38.1 s |
| `/about` slow 4G, after | 11 KB | 6.5 KB | 0 | 25 | 34.7 s (+0.44) | 38.0 s |
| `/agents` no throttle, before (main) | 1,456 KB (8 req) | 980 KB | 980 KB | 3,024 | — | — |
| `/agents` no throttle, after | 35 KB (6 req) | 29 KB | 1 KB | 370 (298 are inline app-family sheets) | 2.9 s (+0.5) | 3.7 s |
| `/agents` fast 4G, before (main) | 1,456 KB | 980 KB | 980 KB | 3,024 | 46.8 s | 47.3 s |
| `/agents` fast 4G, after | 35 KB | 29 KB | 1 KB | 371 | 43 s (+1.3) | 45.2 s |

On prod (equin.ai, gzip) `/about` shipped 82 KB of icons on the wire cold;
the same 11 KB raw is ~4 KB gzip.

Notes:

- The first warm load fetches the remembered batches' ASSETS once (the first
  load read them through the live value, which is `no-store`); from the next
  load on they come from the browser cache.
- A glyph wanted after the first frame (a saved avatar whose row lands later:
  `crown` on `/agents`) is read live (`no-store`) on every load — one small
  batch, not a set. Making on-demand immutable live values cacheable is a
  live-state substrate change (its HTTP reads are `no-store` by design, the
  cache-poisoning rule) — left out here.
- Icons mounted after the first commit (a pane whose data loads later) are not
  waited for: they show one batch round trip after they mount.
- Throttled timings are noisy on a loaded host (`/agents` fast 4G cold ranged
  45–61 s across runs); the byte numbers are exact.
