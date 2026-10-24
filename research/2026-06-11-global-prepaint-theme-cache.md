# Persistent pre-paint theme cache

> **Convergence note (post-plan):** while this branch was in review, main landed
> `79bf39b42` (`research/2026-06-11-global-theme-fouc-elimination.md`) — an
> independent, equivalent implementation of Leg A (localStorage envelope at
> `theme-engine:critical-css`, inline replay script, same-id style adoption,
> neutral cold floor). On rebase, this branch **adopted main's Leg A** and
> dropped its own duplicate (`paint-cache.ts` + per-app-path inline script).
> Legs B and B2 below landed as planned — they fix the default-preset flash
> that main's Leg A alone does not (its GroupStyle still fell back to
> `presets[0]` while tweakcn loaded, overwriting the replayed CSS). Two gaps of
> the adopted Leg A vs this plan's, accepted for now (both self-heal on mount):
> the envelope is global rather than per-app-path keyed (reload after switching
> apps replays the last-visited app's theme for the pre-mount frames), and it
> stores the resolved dark bit rather than the configured mode (an OS scheme
> flip between sessions replays stale until mount).

## Context

Two artifacts appear on every hard refresh:

1. **Black screen until the app mounts.** `App.tsx` renders `null` until plugin bundles load and every `Core.Boot` task (config snapshot fetch) settles. `index.html` hardcodes `<html class="dark">`, so the blank pre-React screen renders in the UA dark scheme (black) — wrong for light-mode users, and visually a "dead" frame for everyone. Nothing theme-related is persisted across reloads today; the existing "hydrate before first paint" commits (`e85f43d82`, `4c9d86959`) seed the *in-memory* query cache from a network fetch on every load.
2. **Default-preset color flash.** Theme CSS vars are injected at runtime by `GroupStyle` (`theme-injector.tsx`), resolving the active preset as `presets.find(p => p.id === config.preset) ?? presets[0]`. Dynamic presets (tweakcn) arrive via `useEndpoint(listTweakcnThemes)` *after* first paint, so a configured tweakcn preset paints as the default preset first, then snaps to the real theme.

Fix has three legs — all needed:

- **A. Pre-paint cache**: persist the final resolved CSS var blocks + configured color mode to localStorage; a tiny inline script in `index.html` applies them before the bundle loads.
- **B. Boot hydration of the tweakcn list**: so React's *own* first injection is already correct (otherwise GroupStyle, later in document order, overwrites the cached correct CSS with default-preset values).
- **B2. Structural guard**: make the preset-source contract loading-aware so *no* future dynamic source can reintroduce this bug class by forgetting to boot-hydrate.

## Verified facts the design rests on

- Gateway serves `dist/` byte-for-byte (Go `http.ServeFile`), no CSP, no HTML transform. Vite (root `web/`, `vite.config.ts:7`) leaves inline non-module scripts in `index.html` verbatim. No check/lint scans `index.html`.
- `app.css` declares **no token values** — only `color-scheme` and `body { @apply bg-background ... }`. All values come from runtime `<style id="theme-engine-<group>">` elements; later-appended elements win at equal specificity, so a static cached `<style>` is automatically superseded once React injects.
- App id ≠ path segment (`/agents`→`agent-manager`, `/files`→`file-explorer`). Matching is longest-path-prefix (`plugins/apps/web/internal/use-active-app.ts:21-36`). The apps barrel exports `useActiveApp(): {id, path} | undefined`.
- The inline script must stay **plugin-agnostic** (web-core is the composition root): no hardcoded app list. Cache entries are keyed by app *path* written at runtime; the script prefix-matches `location.pathname` against stored keys, falling back to a `""` (global) entry. Non-app routes (e.g. `/a/:id`) have `scopeId === undefined` → global theme → `""` entry. Correct by construction.
- Per-app config reads fall back to global unless `useScopeForked(scopeId)` (`use-config.ts:54-65`). Color mode is a per-app config field `colorMode: "light"|"dark"|"system"` (`theme-engine/core/config.ts`), resolved against `matchMedia` when `"system"`.
- `useEndpoint` query key: `["endpoint", route, JSON.stringify(params ?? {}), JSON.stringify(query ?? {})]` (`endpoints/web/internal/use-endpoint.ts:26-31`). The app-wide `QueryClient` singleton lives in live-state (`getDefaultQueryClient`, `use-resource.ts:17-25`); `hydrateResource` seeds it. endpoints and live-state do not import each other today → adding endpoints→live-state is DAG-safe.
- Each worktree subdomain is its own origin → separate localStorage, no cross-worktree pollution.
- `useTokenGroupPresets` has ~10 external consumers (every `ui/tokens/*` plugin's DynamicEnum options + `google-fonts-loader`) that `.map()` the result directly — the contract change must update them (mechanical).

## Leg B — generic endpoint boot hydration (do first)

### `plugins/primitives/plugins/live-state/web/use-resource.ts` + barrel

Export a narrow seeder (keep `getDefaultQueryClient` private):

```ts
// Seed an arbitrary query on the app's default QueryClient before mount.
// Companion to hydrateResource for non-resource (plain endpoint) queries.
export function hydrateQuery(queryKey: unknown[], data: unknown): void {
  getDefaultQueryClient().setQueryData(queryKey, data);
}
```

Re-export from `plugins/primitives/plugins/live-state/web/index.ts`.

### `plugins/infra/plugins/endpoints/web/internal/hydrate-endpoint.ts` (new) + barrel

Mirrors `useEndpoint`'s key construction **exactly** (byte-match is load-bearing — co-locate a shared `endpointQueryKey()` helper used by both `use-endpoint.ts` and `hydrate-endpoint.ts` so they cannot drift):

```ts
export function hydrateEndpoint<Route extends string, TParams, TResponse, TQuery>(
  endpoint: EndpointDef<Route, TParams, void, TResponse, TQuery>,
  params: TParams,
  opts: { query?: TQuery } | undefined,
  data: TResponse,
): void {
  hydrateQuery(endpointQueryKey(endpoint, params, opts?.query), data);
}
```

Refactor `use-endpoint.ts` to use the same `endpointQueryKey`. Re-export `hydrateEndpoint` from `endpoints/web/index.ts`.

### `plugins/ui/plugins/tweakcn/web/boot.ts` (new) + `web/index.ts`

```ts
// Pre-paint hydration of the tweakcn preset list. Without it, GroupStyle's first
// injection runs before useEndpoint resolves and would paint the default preset
// over the pre-paint cached CSS, reintroducing the flash. runBootTasks
// (web-core App.tsx) allSettles, so a failure degrades to today's behavior.
export const tweakcnBootTask = Core.Boot({
  run: async () => {
    const data = await fetchEndpoint(listTweakcnThemes, {});
    hydrateEndpoint(listTweakcnThemes, {}, undefined, data);
  },
});
```

Add to `contributions` in `plugins/ui/plugins/tweakcn/web/index.ts` (barrel purity: import + list only).

## Leg B2 — loading-aware preset sources

### `plugins/ui/plugins/theme-engine/web/slots.ts`

```ts
export interface PresetSourceContribution {
  // undefined = still loading (distinct from "no presets for this group")
  usePresets: (groupId: string) => TokenGroupPreset[] | undefined;
}

export type TokenGroupPresets =
  | { pending: true }
  | { pending: false; presets: TokenGroupPreset[] };

export function useTokenGroupPresets(groupId: string): TokenGroupPresets {
  const group = ThemeEngine.TokenGroup.useContributions().find((g) => g.id === groupId);
  const staticPresets = group?.usePresets() ?? [];
  const dynamic = ThemeEngine.PresetSource.useContributions().map((s) => s.usePresets(groupId));
  if (dynamic.some((d) => d === undefined)) return { pending: true };
  return { pending: false, presets: [...staticPresets, ...dynamic.flatMap((d) => d!)] };
}
```

`{pending}` union per repo precedent (`0f02e0680` — no isLoading+empty-defaults footgun).

### `plugins/ui/plugins/tweakcn/web/index.ts` (PresetSource)

`if (!data) return undefined;` instead of `[]`. With the boot task, data is present on first render, so the pending state is normally never observed.

### `theme-injector.tsx` (GroupStyle)

While `pending`, **skip injection entirely** (no `<style>`, no cache report) — the pre-paint cached style stays authoritative. When resolved, keep the existing `?? presets[0]` fallback (now only reachable for a genuinely deleted preset id):

```ts
const state = useTokenGroupPresets(group.id);
const active = state.pending
  ? null
  : (state.presets.find((p) => p.id === config.preset) ?? state.presets[0] ?? null);
```

The existing `!active → {null,null} → effect early-return` path already yields no injection.

### Mechanical consumer updates (~10 files)

Every `useTokenGroupPresets("<group>").map(...)` in `plugins/ui/plugins/tokens/plugins/{color-palette,sidebar-palette,categorical,chart,density,shape,shadow,font-family,type-scale}/web/index.ts` and `font-family/plugins/google-fonts/web/internal/google-fonts-loader.tsx` becomes:

```ts
const state = useTokenGroupPresets("color-palette");
const options = state.pending ? [] : state.presets.map(...)
```

(pending → empty options list is correct for dropdowns/font-preload; it self-fills on resolve.)

## Leg A — pre-paint cache

### `plugins/ui/plugins/theme-engine/web/internal/paint-cache.ts` (new)

Writer side of the cross-boundary localStorage contract:

```ts
// CONTRACT: key + JSON shape are read by the plugin-agnostic inline <script> in
// plugins/framework/plugins/web-core/web/index.html, which cannot import this
// module. Keep both sides in sync. Bump :v1 on shape changes.
const KEY = "theme-engine:paint-cache:v1";

type CachedColorMode = "light" | "dark" | "system";
interface PaintCacheEntry { css: string; colorMode: CachedColorMode; }
interface PaintCache { entries: Record<string, PaintCacheEntry>; } // key: app path, "" = global

const groupCss = new Map<string, string>();
let ctx: { appPath: string | undefined; colorMode: CachedColorMode; forked: boolean } | undefined;
let scheduled = false;

export function reportGroupCss(groupId: string, cssText: string): void
export function clearGroupCss(groupId: string): void
export function reportPaintContext(c: typeof ctx): void
```

Each report sets state and schedules a `queueMicrotask` persist (one-shot coalescing — not interval polling). `persist()`:

- no-op until `ctx` set and `groupCss` non-empty;
- combine `[...groupCss.entries()].sort()` values with `\n` (deterministic order; runtime styles win over the cache by document order anyway, the cache only needs self-consistency);
- write `entries[ctx.appPath ?? ""] = { css, colorMode }`;
- when `!ctx.forked` and `ctx.appPath` is set, **also** write `entries[""]` (an unforked app's resolved CSS *is* the global theme); a forked app must never clobber `""`;
- `read()` tolerates corrupt/missing JSON by resetting to `{ entries: {} }` (console.warn — non-fatal by design, the runtime path is authoritative).

### `plugins/ui/plugins/theme-engine/web/components/theme-injector.tsx`

1. **GroupStyle layout effect**: after `el.textContent = ...`, call `reportGroupCss(group.id, el.textContent)`; cleanup adds `clearGroupCss(group.id)` next to `el.remove()`.
2. **ThemeInjector**: switch `useCurrentAppId()` → `useActiveApp()` (need `path`; `scopeId = app:${active.id}` unchanged). Read the **configured** (not resolved) color mode via `useConfig(themeEngineConfig, { scopeId }).colorMode` and report context in a `useLayoutEffect` (layout, not passive — the persist microtask flushes after the commit's layout effects, so context must be current by then):
   ```ts
   useLayoutEffect(() => {
     reportPaintContext({ appPath: active?.path, colorMode, forked });
   }, [active?.path, colorMode, forked]);
   ```
   Storing the configured mode (not the resolved light/dark) lets the inline script re-resolve `"system"` against live `matchMedia` on every load — an OS appearance change between sessions still paints correctly.
3. **Cache element cleanup**: one passive `useEffect(() => { document.getElementById("theme-paint-cache")?.remove(); }, [])` — runs after children's layout effects, so real styles are already in place. Removing avoids a stale static style lingering during in-session theme edits.
4. `persistActiveForkedScope` wiring stays as-is.

### `plugins/framework/plugins/web-core/web/index.html`

- `<html lang="en" class="dark">` → `<html lang="en">` — the script owns the class now (light-mode users currently get a wrong black pre-paint).
- Inline non-module `<script>` in `<head>` before `<script type="module" src="/main.tsx">`, ~25 lines of vanilla JS:
  1. `prefersDark = matchMedia("(prefers-color-scheme: dark)").matches`;
  2. `try { parse localStorage["theme-engine:paint-cache:v1"] }` — longest-prefix match of `location.pathname` against non-`""` entry keys (`path === k || path.startsWith(k + "/")`), falling back to `entries[""]`; shape-check `typeof entry.css === "string"`;
  3. `mode = entry?.colorMode ?? "system"`; `dark = mode === "dark" || (mode !== "light" && prefersDark)`; `documentElement.classList.toggle("dark", dark)`;
  4. if entry: append `<style id="theme-paint-cache">` with `entry.css` to `document.head`.
  - The `catch` falls through to the system-preference default (with a `console.warn`): this is the one place fail-soft is correct — a corrupt cache must not cost the dark-class decision, and the runtime path self-heals + rewrites the cache a moment later. Comment in the script points at `paint-cache.ts` as the contract owner.
  - Cascade safety: the Vite CSS `<link>` carries no token values; runtime `theme-engine-*` styles are appended later in document order and win at equal specificity.

## Edge cases

| Case | Behavior |
|---|---|
| First-ever visit (cold cache) | No entry → correct `dark` via matchMedia, no cached style; brief tokenless frame (≤ today), then correct theme on first injection (Leg B makes it the *right* preset immediately). |
| Theme changed in another tab/agent | Stale pre-paint frames, then mount corrects and rewrites the cache. Same self-heal model as `active-forked-scope`. |
| Deleted tweakcn preset still configured | `find` misses → `presets[0]` default (today's semantics); cache overwritten on next persist. |
| OS scheme flips while cached `"system"` | Re-resolved against live matchMedia each load — never stale. |
| Forked app | Writes only its own path entry; `""` untouched. |
| Route matching no app (`/a/:id`) | `appPath` undefined → writes/reads `""` (global). |
| Stale entries for renamed/removed apps | Unreachable keys, bounded by app count; harmless. |
| localStorage quota | ~5–15 KB/entry × ~10 apps — negligible. |
| Boot task failure (tweakcn down) | `allSettled` in `runBootTasks` → logged, degrades to pending presets → no injection until endpoint resolves (cached style holds meanwhile). |

## Implementation order

1. `hydrateQuery` (live-state) + `endpointQueryKey` refactor + `hydrateEndpoint` (endpoints).
2. `slots.ts` contract + tweakcn `undefined` + GroupStyle pending skip + ~10 consumer updates (one type-check pass).
3. tweakcn `boot.ts` + barrel registration.
4. `paint-cache.ts` + ThemeInjector wiring.
5. `index.html` inline script + `class="dark"` removal.
6. Regenerate docs via `./equin build`; add a pre-paint-cache bullet to the theme SKILL (`.claude/skills/theme/SKILL.md`) and a prose note in `plugins/ui/plugins/theme-engine/CLAUDE.md`.

## Verification

1. `./equin build` — type-check (contract change fan-out), plugin-boundaries (new endpoints→live-state edge), doc regen. Inspect `plugins/framework/plugins/web-core/dist/index.html`: inline script verbatim, no `class="dark"`.
2. **Cold cache**: in the deployed app run `localStorage.clear()`, hard refresh on an app with a tweakcn preset configured → no default-preset flash anymore (Leg B); pre-paint frame is system-scheme-colored, not forced dark.
3. **Warm cache**: refresh again → pre-paint frame already shows the configured theme background (no black, no flash). Confirm `#theme-paint-cache` is removed from `<head>` after mount and `theme-engine:paint-cache:v1` is populated with the app path + `""` entries.
4. **Scripted check**: `bun e2e/screenshot.mjs --url http://<wt>.localhost:9000/agents --out /tmp/theme-warm` plus a short-wait variant (`playwright screenshot --wait-for-timeout 50`) to catch the first frames; compare against the steady-state screenshot.
5. **Light mode**: set `colorMode: light`, refresh → pre-paint frame light, no dark flash.
6. **Forked app**: fork a theme on one app, refresh it (forked colors pre-paint) and refresh an unforked app (global colors pre-paint; `""` entry not clobbered by the fork).
7. Theme customizer still works: presets dropdowns populate (pending → `[]` → filled), switching presets updates live and rewrites the cache.
