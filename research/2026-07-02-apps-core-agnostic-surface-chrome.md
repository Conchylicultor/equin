# Make the app surface agnostic to tab-bar / rail / desktop chrome

## Context

`apps-core/plugins/layout` (`AppsLayout`, the `Core.Root` app surface) currently
**hard-imports** four sibling plugins:

| Import (in `layout/web/components/apps-layout.tsx`) | Symbol | Role |
|---|---|---|
| `@plugins/apps-core/plugins/tabs/web` | `TabsProvider`, `useTabs` | **Substrate** — tab/focus state read by every region |
| `@plugins/apps-core/plugins/tab-surface/web` | `AppTabsBody` | **Substrate** — the guaranteed minimal body (keep-alive tab stack); layout's fallback so the surface is never a black screen |
| `@plugins/apps-core/plugins/tab-bar/web` | `AppTabBar` | **Chrome** — rendered *unconditionally* at the top |
| `@plugins/apps-core/plugins/app-rail/web` | `AppRail` | **Chrome** — referenced only inside the inline `DefaultRailFraming` fallback |

Because these are hard-import edges, the composition closure (`hardClosure`,
`plugin-meta/plugins/closure`) forces **all four** into any bundle that includes
the surface. There is no way for a release composition to ship the app surface
without the tab bar and rail chrome — and "which chrome an app ships" is not
expressible through the composition system at all.

Two of the six chrome-ish dependencies are **already soft** (consumed only via
slots defined in `apps-core/web/slots.ts`, with inline fallbacks, never
hard-imported):

- `Apps.RailFraming` ← `apps-core/app-rail-framing` (has `rail` + `hidden` variants)
- `Apps.Surface` ← `apps-core/surface` (has `docked` / `floating` / `solo` placements)

This surfaced while fixing the self-contained-release black screen, where the
whole surface was dropped because `apps-core.layout` (a `Core.Root` contributor
nothing hard-imports) fell out of the composition closure. That immediate fix
seeds `apps-core.layout` into `served-baseline`. **This task is the follow-up
structural improvement.**

### Goal

Turn `tab-bar` and `app-rail` into **soft, opt-in** slot contributions with
import-free fallbacks, so a composition can include the app surface and
**independently** choose whether the tab bar, rail, and desktop/floating
placement are present. `tabs` and `tab-surface` stay hard (they are the surface's
load-bearing substrate, not chrome).

### Decisions (confirmed with user)

- **Chrome is opt-in, wired into nothing by default.** Apps release chrome-less
  (no tab bar / no rail) by default. A new **`app-chrome` pack** bundles the full
  chrome for any composition that wants it, but **no composition extends it by
  default**.
- **Demonstrate with `sonata`.** Once chrome is opt-in, the existing `sonata`
  app composition becomes chrome-less automatically; verify its `--composition`
  build renders the piano app with no tab bar / rail.

### Why this is low-risk

The **main dev app is unfiltered** (ships every plugin via `web.generated.ts`),
so `tab-bar`, `app-rail-framing`, and `surface` always contribute there — the
main app's appearance is **unchanged** by this refactor. Only `--composition`
release bundles (`web.composition.generated.ts`) are affected, which is exactly
the intent.

---

## Structural changes

### 1. Add an `Apps.TabBar` slot — `apps-core/web/slots.ts`

Mirror the existing `Apps.Surface` single-contribution slot (same file):

```ts
/** The top tab strip. A single-contribution slot (the `tab-bar` plugin); `apps`
 * renders nothing here when no contributor is present (chrome-less surface). */
export interface TabBarContribution {
  component: ComponentType<Record<string, never>>;
}
// inside the `Apps` object:
TabBar: defineSlot<TabBarContribution>("apps.tab-bar", {
  docLabel: () => "Tab bar",
}),
```

> Note: distinct from the existing `Apps.TabBarActions` slot (the trailing action
> zone *inside* the strip). `Apps.TabBar` hosts the strip itself.

### 2. `tab-bar` contributes `AppTabBar` — `apps-core/plugins/tab-bar/web/index.ts`

Follow the byte-shape of `app-rail-framing/web/index.ts` (Apps-slot contributor):

```ts
import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { AppTabBar } from "./components/app-tab-bar";

export default {
  description: "App tab bar: the top tab strip ...", // unchanged
  contributions: [Apps.TabBar({ component: AppTabBar })],
} satisfies PluginDefinition;
```

Drop the `export { AppTabBar }` re-export — `layout` was its only importer, and
it is now internal. (`AppTabBar` renders no props; the `Record<string, never>`
contract matches `Apps.Surface`.)

### 3. Render the tab bar via the slot + de-import the rail fallback — `apps-core/plugins/layout/web/components/apps-layout.tsx`

- **Remove** `import { AppRail }` (line 20) and `import { AppTabBar }` (line 21).
- **Replace** the unconditional `<AppTabBar />` (line 116) with a slot host that
  renders the first `Apps.TabBar` contribution via `renderIsolated`, or nothing
  when empty (mirrors the `Apps.Surface` branch already in `FramedSurface`):

  ```tsx
  function TabBarHost() {
    const tabBar = Apps.TabBar.useContributions()[0];
    return tabBar
      ? renderIsolated(Apps.TabBar.id, tabBar as unknown as Contribution, {})
      : null;
  }
  ```
  Keep it inside `<TabsProvider>` (the strip reads `useTabs()`).

- **Replace** `DefaultRailFraming` (which hard-renders `<AppRail />`) with an
  **import-free** railless fallback — full-width body, `--app-rail-width: 0px`
  (mirrors `app-rail-framing/hidden`'s `HiddenFraming`, so any downstream reader
  of the CSS var still gets a consistent value):

  ```tsx
  /** Import-free fallback when no app-rail-framing contributor is loaded: no
   * rail, body fills full width. Rail chrome is opt-in via Apps.RailFraming. */
  function RaillessFraming({ body }: RailFramingProps) {
    return (
      <Stack direction="row" gap="none" className="h-full min-h-0"
        style={{ "--app-rail-width": "0px" } as React.CSSProperties}>
        {body}
      </Stack>
    );
  }
  ```
  `FramedSurface`'s `framing ? … : <RaillessFraming …/>` branch is otherwise
  unchanged. The `AppTabsBody` fallback for `Apps.Surface` **stays** (hard
  substrate).

**Net effect:** `layout`'s hard closure becomes `{ tabs, tab-surface }` (+
primitives). `tab-bar` and `app-rail`/`app-rail-framing` and `surface` are all
soft/opt-in. Rail and tab bar in the full dev app still render (their plugins
contribute); in a filtered bundle they appear only if selected.

### Critical files (structural)

- `plugins/apps-core/web/slots.ts` — add `Apps.TabBar`
- `plugins/apps-core/plugins/tab-bar/web/index.ts` — contribute `AppTabBar`
- `plugins/apps-core/plugins/layout/web/components/apps-layout.tsx` — slot host + railless fallback, drop two imports

---

## Composition changes — `plugins/plugin-meta/plugins/composition/core/config.ts`

### 4. Seed the surface substrate into `served-baseline`

Add `"apps-core.layout"` to the `served-baseline` subsystem entry list (subsumes
the immediate black-screen fix — idempotent if that fix merges first). This gives
every served app the **chrome-less** surface substrate: `layout` → `tabs` +
`tab-surface`, rendering a docked-only body via the `AppTabsBody` fallback, with
no tab bar / no rail.

```ts
subsystem("served-baseline", "aN5", [
  "apps-core.layout",   // ← the app surface substrate (tabs + tab-surface via hard closure)
  "infra.health",
  "shell.toast",
  // …tokens…
]),
```

### 5. Add the `app-chrome` pack (opt-in; extended by nothing)

Mirror the existing `pack("self-improvement", …)` / `pack("theming", …)` shape.
Enumerate the soft contributors — variant/placement sub-plugins are themselves
soft and must be listed explicitly (soft contributions are never auto-included):

```ts
pack("app-chrome", "aQ", [
  "apps-core.tab-bar",
  "apps-core.app-rail-framing",
  "apps-core.app-rail-framing.rail",   // the default rail variant
  "apps-core.surface",
  "apps-core.surface.docked",
  "apps-core.surface.floating",         // desktop/floating placement
  "apps-core.surface.solo",
]),
```

> **Confirm exact ids at build time** by listing `plugins/apps-core/plugins/{app-rail-framing,surface}/plugins/`.
> The `composition-closure` check validates that every entry is a genuine
> load-bearing soft option; a test build will flag any missing/wrong id. Pick the
> next free `rank` after `theming` ("aP").

**No `app()` / profile edits** — per the decision, no composition extends
`app-chrome`. It exists purely as the opt-in bundle a future chrome composition
(or an updated agent-manager profile) can `extends`. Fine-grained lean builds can
instead select individual contributors (e.g. just `apps-core.tab-bar`).

The `compositions.origin.jsonc` committed artifact regenerates via
`./equin build` (never hand-edited).

### Critical files (composition)

- `plugins/plugin-meta/plugins/composition/core/config.ts` — `served-baseline` + `app-chrome` pack
- `plugins/plugin-meta/plugins/composition/core/config.test.ts` — extend taxonomy assertions if they enumerate packs (check whether `app-chrome` must be added to a count/whitelist)

---

## Verification

1. **Build + checks (main app unaffected):**
   ```bash
   ./equin build
   ./equin check composition-closure   # pack ids resolve, selections are load-bearing
   ```
   Open `http://att-1783004663-87ce.localhost:9000` — tab bar + rail + placements
   still present (unfiltered build), confirming zero regression.

2. **Composition-closure unit test:**
   ```bash
   bun test plugins/plugin-meta/plugins/composition/core/config.test.ts
   ```

3. **Lean proof — sonata chrome-less:** build the filtered composition and screenshot.
   ```bash
   ./equin build --composition sonata
   ```
   Then a scripted Playwright run (via `e2e/screenshot.mjs`) against the served
   sonata surface: assert the piano app renders and **no** tab strip / app rail is
   present. Confirms the surface (`layout` + `tabs` + `tab-surface`, docked body)
   works with chrome fully excluded.
   > Sonata already `excludes: ["agent-runtime", "auth"]`; it now also ships
   > without tab-bar/app-rail-framing/surface because it never extends `app-chrome`.

4. **Opt-in proof (optional):** temporarily add `"app-chrome"` to sonata's
   `extends`, rebuild `--composition sonata`, screenshot → tab bar + rail + floating
   placement now present. Revert. Demonstrates the axis is independently choosable.

---

## Out of scope / notes

- `tabs` and `tab-surface` remain hard dependencies of `layout` by design — they
  are the surface's substrate (state + guaranteed body), not chrome. Making the
  minimal body soft would reintroduce black-screen fragility.
- Desktop/floating placement is *already* independently choosable (it is
  `apps-core.surface.floating`, a soft sub-plugin) — this task only needs to keep
  it out of any default bundle, which the opt-in `app-chrome` pack does.
- Docs (`apps-core`/`layout`/`tab-bar` CLAUDE.md, `plugins-*.md`) regenerate via
  `./equin build`; the `plugins-doc-in-sync` check enforces it.
