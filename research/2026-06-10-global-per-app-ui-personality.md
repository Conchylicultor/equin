# Per-app UI personality — pluggable chrome regions (v1: sidebar framing)

## Context

Today every app (Pages, Studio, Home, Agent Manager, …) renders the **same**
chrome: a flush left sidebar (`<Sidebar>` with hardcoded defaults), the same
toolbar bar, the same Miller-columns main area. The user wants each app to carry
its own **visual personality** — different sidebar/layout *shapes* — the way a
macOS Finder window (flush, sectioned rail) differs from a shadcn dashboard
(floating rounded inset card, accent CTA).

Personality decomposes into two orthogonal dimensions, and the codebase already
owns one of them:

- **Palette / accent / radius / fonts** → already solved by the **token-group**
  system (`plugins/ui/tokens/*`, including a dedicated `sidebar-palette` group)
  plus **tweakcn** presets, already per-app-forkable via the theme-customizer's
  "Customize for {App}" toggle. *Nothing to build here.*
- **Structural shape** (sidebar framing, later rail/toolbar/layout) → a
  *component swap*, not a color. This is what we build.

The existing `segmented-progress-bar` plugin is the proven pattern for "a
pluggable component with switchable variants" selected from config and surfaced
in the theme-customizer. We generalize that pattern into a reusable factory, then
apply it to one region: **sidebar framing**.

**v1 scope (decided):** the `defineVariantRegion` factory + the **sidebar-framing**
region only (`flush` / `floating` / `inset`), per-app, **neutral default** (every
app stays flush until a user opts in per app). Rail / toolbar / main-area-layout
regions are a follow-up task.

## Approach

### 1. New factory primitive — `plugins/ui/plugins/variant-region/`

Lives under the `plugins/ui` umbrella (documented home for "pluggable UI
components with switchable visual variants"). It must **not** live under
`plugins/primitives/` — it hard-depends on `config_v2`, `theme-engine`, and
`apps`, which primitives may not import.

It collapses the 6-piece boilerplate (`segmented-progress-bar` today: config +
slot + host + picker + 3 registrations) into two factory calls split across the
mandatory `core`/`web` runtimes (the config descriptor must be visible to the
server for `ConfigV2.Register`).

**`core/define-variant-region.ts`** — `defineVariantRegion<Props>({ id, label, defaultVariant, scope? })`
returns a frozen `VariantRegionCore<Props>` holding:
- `config` = `defineConfig({ name: id, fields: { variant: dynamicEnumField({ default: defaultVariant }) }, scope })`
- `variantField` = `config.fields.variant` (the canonical frozen reference)
- the descriptive fields (`id`, `label`, `defaultVariant`, `scope`).

`scope: "app"` opts the descriptor into the **existing** per-app fork mechanism
(`forkScope`/`deleteScope` fork *all* `scope: "app"` descriptors at once) — zero
new fork plumbing. Omitting `scope` → a global (shared-chrome) region.

**`web/define-variant-region-web.ts`** — `defineVariantRegionWeb(core)` returns:
- `Variant` — the `defineSlot<{ id, label, match, component: ComponentType<Props> }>("ui.variant-region.<id>.variant")` each variant sub-plugin contributes to.
- `Region` — the host component: reads active variant via
  `useConfig(core.config, { scopeId })` + `slot.useContributions()`, renders it
  with `renderIsolated(slot.id, active, props)`.
- `Picker` — the settings UI (extracted from
  `segmented-progress-bar/web/components/variant-picker.tsx`).
- `contributions` — `[ConfigV2.WebRegister, DynamicEnum.Options({ field: core.variantField, … }), ThemeEngine.VariantGroup({ id, componentLabel: label, component: Picker })]`
  to spread into the consuming plugin's `contributions`.

**`server/define-variant-region-server.ts`** — `variantRegionServerContribution(core)` = `ConfigV2.Register({ descriptor: core.config })`.

#### The one real subtlety — two scope sources (R1)

- **`Region`** (the live chrome) reads `useCurrentAppId()` →
  `scopeId = "app:" + appId` (always app-scoped; `useConfig` transparently falls
  back to the global/base value when the app isn't forked).
- **`Picker`** (inside the customizer) reads `useThemeScopeId()` (the customizer's
  *editing* target — only an `app:<id>` once "Customize for {App}" is on, else
  base), exactly like the token-group rows. This makes picker edits land in the
  same tier as palette edits.

The factory must support both; they are deliberately different. Getting this
wrong means either the live chrome doesn't react per-app, or picker edits write
the wrong tier.

### 2. First region — `plugins/ui/plugins/sidebar-framing/`

```
plugins/ui/plugins/sidebar-framing/
  core/{region.ts, types.ts, index.ts}      # defineVariantRegion(...)
  web/index.ts                               # defineVariantRegionWeb(...) + AppShell.Framing contribution
  server/index.ts                            # variantRegionServerContribution(...)
  plugins/flush/    web/components/flush-framing.tsx     (default = today's markup verbatim)
  plugins/floating/ web/components/floating-framing.tsx  (<Sidebar variant="floating">)
  plugins/inset/    web/components/inset-framing.tsx     (<Sidebar variant="inset">)
```

The framing variant owns the **entire** `SidebarProvider`/`Sidebar`/`SidebarInset`
wrapper (framing spans both sidebar and main). Props are the *pieces*, defined in
**app-shell** (so the contract lives with the consumer, avoiding an app-shell→ui
dependency):

```ts
interface SidebarFramingProps { header?: ReactNode; sidebarContent: ReactNode; body: ReactNode; }
```

- `flush` = the current `app-shell-layout.tsx` sidebar branch **extracted byte-for-byte** → default is pixel-identical.
- `floating` / `inset` = same component, `<Sidebar variant="floating" | "inset">` (shadcn already supports both; `inset` auto-rounds `SidebarInset`).

`scope: "app"` → the `Region` host reads the current app's scoped framing; unforked
apps fall back to `flush`. **No app shell code changes.**

### 3. app-shell delegation (dependency-clean)

`app-shell` is a primitive and must not import `plugins/ui/*` (R5). Resolution:
- app-shell defines a render slot `AppShell.Framing` (`defineRenderSlot<{ component: ComponentType<SidebarFramingProps> }>`) and owns the `SidebarFramingProps` type.
- `sidebar-framing/web` contributes `SidebarFraming.Region` into `AppShell.Framing`.
- `AppShellLayout`'s sidebar-bearing branch builds `sidebarContent` (`<sidebarSlot.Render>…`) and `body` (toolbar + `<main>`) as before, then renders the **contributed** framing if present, else an inline `DefaultFlushFraming` (the extracted current markup). The ~11 app shells keep their existing `<AppShellLayout sidebarSlot toolbarSlot>…` calls untouched.

### 4. Settings — no new UI

The factory's `ThemeEngine.VariantGroup` contribution means the picker renders
automatically in the theme-customizer (`theme-customizer.tsx` already maps every
VariantGroup to `<g.component/>` inside `<ThemeScopeProvider>`), below the existing
"Customize for {App}" toggle, per-app for free.

## Files

**New — `plugins/ui/plugins/variant-region/`:** `package.json`; `core/define-variant-region.ts` + `core/index.ts`; `web/define-variant-region-web.ts` + `web/index.ts`; `server/define-variant-region-server.ts` + `server/index.ts`.

**New — `plugins/ui/plugins/sidebar-framing/`:** `core/{region.ts,types.ts,index.ts}`; `web/index.ts`; `server/index.ts`; `plugins/{flush,floating,inset}/{package.json, web/index.ts, web/components/*-framing.tsx}`.

**Modified:**
- `plugins/primitives/plugins/app-shell/web/components/app-shell-layout.tsx` — extract `DefaultFlushFraming`; sidebar branch delegates to contributed `AppShell.Framing`.
- `plugins/primitives/plugins/app-shell/web/index.ts` (+ new `web/slots.ts`, `core` type) — define `AppShell.Framing` slot + export `SidebarFramingProps`.

**Reference implementations to mirror:**
- `plugins/ui/plugins/segmented-progress-bar/{core/config.ts, web/slots.ts, web/components/*, web/index.ts, plugins/dots/web/index.ts}` — the 6-piece pattern being collapsed.
- `plugins/ui/plugins/theme-engine/plugins/theme-customizer/web/components/theme-customizer.tsx` — VariantGroup rendering + the `useThemeScopeId()` scope source (R1).

## Risks / gotchas

- **R1 (the leak):** Picker uses `useThemeScopeId()`; Region uses `useCurrentAppId()`. Encode both in the factory.
- **R3 reference equality:** `DynamicEnum.Options` matches the field by `===`. Pass `config.fields.variant` (verified `defineConfig` stores fields by reference). Add a dev assertion `config.fields.variant === variantField`.
- **R4 server registration:** each region needs its 1-line `server/index.ts`; missing it makes `useConfig` throw loudly at boot (acceptable — loud, not silent).
- **R5 dependency direction:** app-shell owns the `SidebarFramingProps` contract + `AppShell.Framing` slot; never import ui from the primitive.
- **R6 flush parity:** extract `flush` verbatim from `app-shell-layout.tsx`; any class drift silently restyles every unforked app. Screenshot-diff an unforked app vs `main` as the guard.

## Verification

1. `./equin build` — must pass (config origin file generated for the new descriptor; CLAUDE/docs regenerated). A half-registration (web but not server `ConfigV2`) throws at boot.
2. Playwright at `http://<worktree>.localhost:9000`:
   - Open Pages → theme customizer → "Customize for Pages" → pick `floating`; screenshot shows the rounded floating sidebar card.
   - Open Studio (unforked) → screenshot shows default `flush` — proves per-app divergence.
   - Fork Studio → `inset` → `SidebarInset` renders `m-2 rounded-xl shadow-sm`; Pages still `floating`.
   - Diff the screenshots to assert framing differs per app.
3. Confirm an unforked app is pixel-identical to `main` (R6 guard).

## Follow-up (separate task)

Apply the same factory to additional regions: **app-rail** (`rail`/`hidden`, *global* — proves the no-scope branch), **toolbar** (`bar`/`floating-pill`), and **main-area layout** (`miller`/`full-pane`, per-app — note the 3 apps that bypass `AppShellLayout` and the `host`/`full` PaneObject list need handling). Each is ~3 tiny files on the factory.
