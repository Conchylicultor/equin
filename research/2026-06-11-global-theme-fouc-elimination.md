# Eliminate theme FOUC: correct theme on the first painted frame

## Context

Theme CSS custom properties (`--background`, `--primary`, `--radius`, font sizes,
density, …) are **not present on the first painted frame**. The values live only
in JS (token-group preset objects) and which preset is active lives in config_v2
(fetched over the network at boot). There is no SSR — the Go gateway serves a
static `index.html`; the Bun server only handles `/api` + `/ws`.

Today's paint timeline:

1. `index.html` arrives with hardcoded `<html class="dark">`, no inline CSS, no token vars.
2. `app.css` loads (via `main.tsx`) — it carries **zero token values** (only `color-scheme`, `@theme`/`@theme inline` bridges, `@utility`, `@layer base`). The static `:root`/`.dark` token literals were already deleted; the `css-vars-single-owner` check enforces a single owner (the token group) per var.
3. `App.tsx` renders `null` until an async `useEffect` finishes `loadPlugins()` + `runBootTasks()` — the latter does a **network fetch** of `/api/config-v2/snapshot`.
4. Only then does `ThemeInjector` mount and, in `useLayoutEffect`, inject one `<style id="theme-engine-<group>">` per token group and toggle `.dark`.

So every load paints an unthemed frame (correct vars resolve to nothing) until React mounts **and** a round-trip resolves. The `web-core/web/theme/CLAUDE.md` currently documents this flash as "accepted." It no longer is.

**Goal:** the first painted frame already carries the correct, fully-injected theme — no hand-maintained static defaults, no one-frame flash of *wrong/unthemed content*. The token group stays the **single source of truth** for every real theme value.

## Approach

One mechanism plus a calm cold floor, mirroring the existing pre-paint precedent
(`active-scope-storage.ts` + `themeScopeBootTask` in `theme-engine/web/internal/boot.ts`):

### Layer 1 — localStorage theme cache, replayed by an inline blocking script (the warm path; ≈every load)

`ThemeInjector` already computes each group's resolved `:root{…}.dark{…}` CSS text. Serialize the full set (all groups + resolved dark/light) into localStorage on every change. A render-blocking inline `<script>` at the top of `index.html` (before the module script) reads that cache and **synchronously, before first paint**, creates `<style id="theme-engine-<group>">` elements with the cached text and sets/removes `.dark`.

It uses the **same `theme-engine-<group>` ids** `ThemeInjector` uses, so when React mounts, `ThemeInjector`'s `getElementById` (theme-injector.tsx:119) finds and reuses each element in place — overwriting `textContent` with server-resolved values (identical in the common case → no flash, no duplicate/reordered styles). The script is generic DOM replay: it names no token, group, or preset — only a stable localStorage key + envelope shape. This keeps web-core free of theme knowledge (boundary rule R10 / collection-consumer separation).

### Cold floor — a neutral, theme-free loading surface (no cache: first-ever visit, incognito, cleared storage)

No build-time default, no second materialization of theme values. On a cache miss the inline script sets `.dark` from `matchMedia('(prefers-color-scheme: dark)')` (matching the `colorMode: "system"` config default), and `app.css` gives `<html>` a **non-token neutral floor** using the `Canvas` CSS system color, which automatically follows `color-scheme` (white under light, dark under dark). So the cold frame is a calm neutral loading surface — not a flash of wrong-colored content — and since `App.tsx` renders `null` until boot completes, only that background is visible during the window anyway. `ThemeInjector` then fills in real values within a frame and `body`'s `bg-background` paints over the floor.

Crucially `Canvas` is a **consumed system color, not a declared token** — the token group remains the sole owner of every `--token`, so the `css-vars-single-owner` check is untouched and there is no generated/duplicated default to keep in sync.

### Cascade ordering (later-in-`<head>` wins at equal specificity)

1. `app.css` `@theme inline` bridges + the `<html>` neutral `Canvas` floor (lowest precedence; floor is a plain `background`, overridden once `body` gets a real `--background`).
2. `<style id="theme-engine-<group>">` — replayed (warm), then overwritten by runtime `ThemeInjector`. Created via `appendChild`, so after app.css.

## Files to create / modify

**theme-engine (ui):**

- **New** `plugins/ui/plugins/theme-engine/web/internal/serialize-vars.ts` — extract `buildVarsBlock(descriptor, values)` and a `renderGroupBlock(descriptor, light, dark)` (`:root{…}.dark{…}` wrapper) out of `theme-injector.tsx:24-36,133`. Pure, no React. This is now the single serializer the runtime uses; extracting it keeps the cache-text and the injected-text provably identical (one function).
- **New** `plugins/ui/plugins/theme-engine/web/internal/theme-cache.ts` — key constant `theme-engine:critical-css`, envelope type, `writeCriticalCss(envelope)` (try/catch on quota → fail soft). Envelope: `{ v: 1, groups: string[] /*sorted ids*/, styles: { [`theme-engine-${id}`]: string }, dark: boolean }`.
- **Edit** `theme-injector.tsx`:
  - `GroupStyle` imports the serializer; reports `{ id, text }` upward (shared map / context callback).
  - Surface the resolved `dark` boolean (from `useResolvedColorMode`, already computed in `ColorModeApplier`).
  - One top-level `useEffect` writes the consolidated envelope after all groups settle (one atomic write — never per-group, to avoid a torn cache).
  - On mount, **prune** orphan `style[id^="theme-engine-"]` whose id isn't in the live group set (cleans a stale-cache replay after a group is removed).

**web-core (framework):**

- **Edit** `plugins/framework/plugins/web-core/web/index.html`:
  - Remove `class="dark"` from `<html>`.
  - Add the inline render-blocking replay `<script>` in `<head>`: read `theme-engine:critical-css` (try/catch), for each `[styleId, css]` create `<style id>` + `appendChild`, then `classList.toggle('dark', envelope.dark)`. On miss/corrupt, set `.dark` from `matchMedia('(prefers-color-scheme: dark)')` (cold floor picks the right shade).
- **Edit** `plugins/framework/plugins/web-core/web/theme/app.css`:
  - In `@layer base`, give `html` a neutral floor: `background: Canvas;` (system color; follows `color-scheme`). `body` keeps `@apply bg-background text-foreground`, which paints over the floor once `--background` resolves. No token var is declared — single-owner check unaffected.
  - Update the theme `CLAUDE.md` note (the "brief unstyled flash is accepted" line) to describe the new warm-cache + neutral-cold-floor model.

**No changes** to `vite.config.ts`, the codegen plugin, or any build/check step — the cold path is pure runtime + static CSS, so there is no generated artifact to produce or guard.

## Reused functions / utilities

- Serializer to extract & share: `buildVarsBlock` + the `:root/.dark` wrapper (`theme-injector.tsx:24-36,133`) → `serialize-vars.ts`.
- Resolved color mode: `useResolvedColorMode` (`theme-engine/web/use-color-mode.ts`), already consumed by `ColorModeApplier`.
- Pre-paint pattern to mirror: `active-scope-storage.ts` + `themeScopeBootTask` (`theme-engine/web/internal/`). These **stay** — they keep `ThemeInjector`'s *runtime* render aligned with the forked-scope config so it doesn't overwrite the replay then re-correct; complementary to the new cache.
- `getElementById` + `appendChild` reuse contract already in `ThemeInjector` (theme-injector.tsx:119-124) — the replay script must use the same ids so React adopts its elements.

## Failure modes (graceful degradation)

- **Cold cache / first-ever / incognito:** no localStorage → neutral `Canvas` floor under the correct `color-scheme`; app is blank (null) during boot anyway; `ThemeInjector` fills real values on mount. No flash of wrong content. (By design, the cold frame is neutral, not fully themed.)
- **Warm, unchanged:** replay paints exact runtime CSS; `ThemeInjector` reuses the same `<style>` ids → no visible change.
- **Group added:** cached `styles` lacks it → that group is briefly unset (neutral floor shows through for it) until `ThemeInjector` injects it on mount; others replay correctly.
- **Group removed:** replay creates an orphan `theme-engine-<gone>` style → `ThemeInjector` prune removes it on mount.
- **Forked-scope app:** replay = "last good frame" (scope-agnostic). Reload of the same app → cache is its theme. Cross-app reload → one frame of the previous app's theme before `ThemeInjector` + `themeScopeBootTask` correct (strictly better than unstyled; same residual as today's boot task).
- **tweakcn (DB) active preset:** warm cache replays the resolved tweakcn CSS correctly. Cold first-ever visit shows the neutral floor (no theme knows DB presets yet), then resolves on mount — same as any cold visit.
- **StrictMode double-invoke:** cache write is idempotent.
- **localStorage quota/disabled:** try/catch both sides → degrades to the neutral cold floor, never breaks.

## Verification

1. **Build:** `./equin build` in the worktree; load `http://<wt>.localhost:9000` and confirm the app is themed normally (no regression).
2. **Warm (Playwright):** load once (let `ThemeInjector` write the cache), customize a token (e.g. switch color-palette preset), hard-reload; assert the first-paint `theme-engine-<group>` `<style>` textContent equals the customized value, and that no duplicate `<style>` ids exist after mount. Frame-by-frame (video/trace) confirm a themed background from frame 0.
3. **Cold (Playwright):** clear localStorage, hard-reload; with an early-paint probe assert `getComputedStyle(document.documentElement).backgroundColor` is the neutral `Canvas` shade (not transparent), and that it tracks emulated `prefers-color-scheme: dark` vs `light`. Confirm no flash of *wrong-colored content* (content is blank during boot), then themed after mount.
4. **Forked scope:** open a forked app, reload, confirm first frame shows the fork's theme (cache + existing `themeScopeBootTask`).
5. **Stale cache:** seed an extra `theme-engine-zzz` style id into the cache, reload, confirm `ThemeInjector` prunes it on mount (no orphan `<style>`).
6. **Checks:** `./equin check` green (no new checks; confirms `css-vars-single-owner` is unaffected since no token var is declared in static CSS).
