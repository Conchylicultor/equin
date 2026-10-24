# Component mockup ⇄ parity harness

## Context

We want a workflow for improving the app's UI:

1. design a mockup for **one component** (a pane, a breadcrumb, …), not a whole screen
2. render the **real component in isolation**, without booting the app — themed, with data supplied somehow
3. **compare** the two, so the gap is visible — and specifically so we can tell *which kind* of gap it is: a design our token/primitive vocabulary cannot express, versus a primitive that is incomplete

Three quarters of this machine already exists and is production-grade. What is missing is a subject for the mockup, a theme on the isolated page, a picture, and — the real gap — a **comparison predicate that answers the question we are asking**.

---

## What exists today

| Piece | Where | What it already does |
|---|---|---|
| **Isolation engine** | `plugins/primitives/plugins/css/plugins/layout-harness/` | Programmatic Vite build (React + **real Tailwind**, `NODE_ENV` pinned to production) of a standalone page → served on an ephemeral `127.0.0.1` port → **one** headless Chromium → `window.__renderFixture(id, width)` / `window.__measure()` → pure DOM-free oracle → `./equin check layout-geometry`, content-hash cached, host-serialized, with **falsification mutations** proving the gate bites. Plus a live in-app gallery (Debug → Layout Lab), one `PluginErrorBoundary` per cell. |
| **Fixture collection** | `layout-harness/core/collected.ts` | `defineCollectedDir("fixtures")` — a plugin drops `fixtures/index.ts`, codegen discovers it, **zero harness edits**. 9 contributors today, all `css/*`. |
| **Mockup authoring** | `prototypes/`, `plugins/apps/plugins/prototypes/` | Minted flat folders in `~/.singularity/apps/prototypes/`, metadata parsed from `<title>`/`<meta>` by HTMLRewriter, gallery with Focus + Compare, `ScaledIframe`. |
| **Isolated HTML → PNG** | `prototypes/plugins/thumbnails/server/internal/render.ts` | Headless Playwright against a **`file://`** doc at a declared viewport → PNG, content-addressed cache. A working mock→picture pipeline. |
| **Browser helpers** | `framework/tooling/plugins/e2e-harness/e2e/` | `withBrowser`, `snap()`, `samplePixels()`/`colorDistance()` — screenshot a rect, decode it back **into the page** onto a canvas, read RGBA. No image dependency. `color-scheme.ts`. |
| **Pure theme serialization** | `ui/plugins/theme-engine/web/internal/serialize-vars.ts` | `renderGroupBlock(descriptor, light, dark, selectors)` → the exact `:root{…}.dark{…}` text. Presets are **static data** in each token-group plugin's `presets.ts`. |
| **Provider scaffold precedent** | `primitives/pane/web/__tests__/surface-fixture.tsx` | `TestSurface` = `PluginProvider` + `PaneSurfaceProvider`, parameterized by an explicit `plugins` list. Plus `renderIsolated(slot, contribution, props)` and `hydrateResource()`. |

---

## The gaps

### 1. A mockup has no subject, and no shared vocabulary with the app

A prototype is a page named by a minted id. Nothing binds one to a component, and the gallery's **Compare compares prototypes to each other** (`rows.map(...)` over the whole list), never against a live component. Worse, `prototypes/CLAUDE.md` deliberately forbids reading `plugins/` or borrowing its tokens — correct for exploring ideas nobody has had yet, wrong as a *component spec*. A mock authored in an unrelated design system can only ever be compared by eye.

### 2. Isolation reaches only prop-driven leaves

`LayoutFixture.render: () => ReactElement` runs with **zero providers**. That covers `css/*`, `Breadcrumb`, `Badge`, `Row`, `Card`. But feature components universally take an id prop and call `useResource` internally — and `useResource` **throws** without `NotificationsProvider` (`live-state/web/use-resource.ts`). `TaskHeader({taskId})` cannot mount at all. The harness reaches primitives and not one feature component.

### 3. The isolated page is not themed

`layout-harness/web/internal/entry.html` hardcodes one density ramp and forces monospace 14px; `ThemeInjector` never runs. Deliberate — it is a *geometry* gate and font determinism matters cross-machine. But there are **no colour tokens, no preset, no light/dark**, so any picture taken from it is grey-on-white, not the app. This also means the existing geometry gate only ever sees the default density.

### 4. Nothing takes a picture, and nothing in the repo compares two images

No `pixelmatch` / `odiff` / `looks-same` / `resemblejs` / `pngjs` anywhere (lockfile checked). `diff-view`'s `ImageDiffView` is two `<img>` side by side with no diffing. `samplePixels` samples **one** screenshot. `measure-page.ts` never calls `page.screenshot`.

### 5. The real gap: there is no comparison predicate, and pixels are the wrong one

This is a design gap, not a missing library.

Two independently-authored renderings of the same design are **never** pixel-equal — sub-pixel text, border rounding, font stacks. A threshold is therefore either permanently red or tuned so loose it catches nothing. And critically, *"4.7% of pixels differ"* cannot answer the question we are asking. **"We can't express this design"** and **"a primitive is incomplete"** are two different diagnoses with two different fixes, and a pixel count distinguishes neither.

---

## The approach

The through-line: **the harness already turns a rendered thing into a comparable record.** `MeasuredFixture` is that record, for geometry. Extend the *record*, not the pipeline.

### A. The mock becomes a second renderer inside the same page

New fixture kind beside the existing ones, collected by the same `defineCollectedDir("fixtures")`:

```ts
// plugins/primitives/plugins/breadcrumb/fixtures/index.ts
export default [{
  kind: "parity",
  id: "breadcrumb/overflow",
  widths: [320, 640, 960],
  themes: ["default:light", "default:dark"],
  component: () => <Breadcrumb segments={SEGMENTS} />,   // the real thing
  mock:      () => <div style={{ /* free CSS */ }}>…</div>,
}] satisfies HarnessFixture[];
```

Both halves mount in the **same document**, same stylesheet, same widths, same `data-geo` marks, read by the same `__measure()`. Comparability is structural, not a convention.

**The rule that makes it work: the mock is authored in free CSS** — raw px, raw hex, no app utilities and no primitives. A mock written as `<Stack gap="sm">` *is* the component again, and its diff is trivially green and worthless. The mock's freedom is precisely what turns every one of its values into a question the report answers.

### B. Extend the record from boxes to a **design signature**

Today `MeasuredFixture.slots[id]` is `{ box, truncates, contentLeft }`. Add the resolved design decisions per slot — paddings, gaps, radius, font-size / line-height / weight, colour, background, border, height — each resolved to a number/colour **by layout probe**, never by parsing computed text (the harness already learned this the hard way for `--rail-start`: `parseFloat("1rem")` reads `1`).

Then the new pure module, sibling of `oracle.ts`: **`snapToToken(property, value) → TokenMatch | null`** — which `--space-*` step, which `--radius`, which `Text` rung, which `--control-height-*`, which palette entry a value lands on, within ε. Pure and DOM-free, so it is unit-testable exactly as `oracle.test.ts` is.

### C. The output is a three-column gap table, not a verdict

Per (slot, property): **mock value | component value | the token they land on**. Four outcomes, four different actions:

| Outcome | Means | Action |
|---|---|---|
| same token, same value | agreement | — |
| both on tokens, **different** tokens | ordinary bug | fix the component |
| mock value lands on **no token** | **the design system cannot express this design** | add a token step, or reject the design |
| component matches only via raw CSS, no primitive behind it | **a primitive is incomplete** | build the primitive |

```
breadcrumb/overflow @ 640px · default:light

slot     property   mock      component  token
──────────────────────────────────────────────────────────────
sep      margin-x   6px       8px        --space-sm    ✗ mock off-ramp
crumb    color      #6b7280   #6b7280    --muted-fg    ✓
crumb    font-size  13px      14px       text-caption  ✗
root     radius     5px       10px       ✗ NO TOKEN    ← design inexpressible

2 mismatches · 1 value the token scale cannot say
```

Rolled up: a per-component expressibility score, and a repo-wide list of design intents our tokens cannot express. **That list is the deliverable** — it is the thing that tells us what to add to the design system.

### D. Screenshots ride along — for the eye, not for the gate

`page.screenshot({ clip })` on the measured container is ~one line in `measure-page.ts`. Write mock and component side by side per (width × theme), both to disk (for an agent to look at) and into the Layout Lab gallery. `samplePixels`/`colorDistance` give a cheap coarse backstop ("are these even the same colour family") with **no new dependency**. The gate is the signature diff; the picture is how a human looks at it.

### E. Theming becomes an axis of the sweep

Resolve a preset **purely** — `renderGroupBlock()` over each token group's static `presets.ts`, no config plugin, no server — and inject the `<style>` before render. Sweep `theme × colour-mode` alongside `width`.

Required for C's colour comparison anyway, and it retires the standing limitation that the geometry gate only ever sees the default density ramp. The monospace/14px pin stays on the **measured-geometry** path and comes **off** the screenshot path.

### F. Data: do not build a mocking framework

Rung 1 of the fix ladder — make the wrong thing unspellable rather than mockable.

- **Prop-driven components work today**, unchanged.
- For feature components, ship the `TestSurface`-shaped scaffold (`PluginProvider` + optional `NotificationsProvider` + `PaneSurfaceProvider`, explicit `plugins` list) and seed data through the **existing** `hydrateResource()`. No fake-hook layer, no interception.
- A component that *still* cannot mount **is the finding**: presentation is fused with fetching. Report it as such. The fix — split a presentational component out — is the same change that makes it mockable, and is worth making on its own merits.

---

## The steps

Each step ends somewhere you can look at the result. Steps 1–3 are worth doing on their own merits and do not depend on any of the open questions below.

### 1. Take the picture, before changing anything

Add a `screenshot(id, width)` method to the `Measurer` in `web/internal/measure-page.ts` (`page.screenshot({ clip })` over the measured container's box, which `__measure()` already returns), plus a small script that sweeps the nine existing contributors and writes PNGs to disk.

Nothing new to keep green. **You end with a folder of pictures of every css primitive at every width** — and they will come out grey and unstyled, which is how we *confirm* the theming gap instead of asserting it.

Files: `layout-harness/web/internal/measure-page.ts`, a new `layout-harness/e2e/shoot-fixtures.ts`.

### 2. Theme the isolated page

Build `theme-preset.ts`: walk each token group's static `presets.ts`, resolve one named preset, and emit its CSS with `renderGroupBlock()` from `theme-engine/web/internal/serialize-vars.ts` — no config plugin, no server. Replace `entry.html`'s hardcoded ramp with that. Make theme a parameter of `__renderFixture` beside width.

**Watch this one:** the existing geometry suite must stay green, and seeding real tokens changes measured boxes. Keep the monospace/14px pin on the measured path and take it off the screenshot path.

**You end with** the same PNG sweep, now across Default / Ocean / Warm × light / dark, looking like the app.

Files: `layout-harness/web/internal/{entry.html,entry.tsx,measure-page.ts}` + new `theme-preset.ts`.

### 3. Put it on screen

Give the Layout Lab gallery a theme switcher and a screenshot view. Cheap, and it is the surface a human actually uses.

Files: `layout-harness/web/internal/gallery.tsx`.

### 4. Add the parity fixture

Add the `ParityFixture` kind to `core/types.ts` and expand it where region fixtures already expand (`web/internal/expand-region-fixtures.ts`), so the three existing consumers keep seeing one fixture shape. Write the first one for **`primitives/breadcrumb`** — prop-driven, non-trivial overflow behaviour, and the component named in the request.

**You end with** the mock and the real breadcrumb side by side, at each width and theme. Still zero assertions.

Files: `layout-harness/core/types.ts`, `layout-harness/web/internal/expand-region-fixtures.ts`, new `plugins/primitives/plugins/breadcrumb/fixtures/index.ts`.

### 5. Extend the measurement into a design signature

Widen `__measure()` from boxes to the resolved style properties, resolving lengths **by layout probe** rather than by parsing computed text — the harness already learned this for `--rail-start`, where `parseFloat("1rem")` reads `1`. Then write `snap-to-token.ts`: pure, DOM-free, "which token does this value land on", unit-tested exactly the way `core/oracle.test.ts` tests the oracle.

**You end with** the three-column gap table printed for `breadcrumb/overflow`.

Files: `layout-harness/web/internal/entry.tsx`, `layout-harness/core/{types.ts,snap-to-token.ts,snap-to-token.test.ts}`.

### 6. Prove the report bites

Follow the harness's own falsification discipline. Hand-edit the mock so each of the four outcomes fires in turn, and confirm the table names the right one. **This is the step that stops us shipping a report that is always green** — the same reason `falsification` exists in the geometry oracle.

### 7. Decide gate vs. report

A decision, not a build step, and step 6 is what informs it. Either wire a contributed check under `layout-harness/check/` (mirroring `layout-geometry`'s signature caching and `classifyFailure`), or leave the table as something an agent reads.

### 8. Reach upward — separate, and optional

The `TestSurface`-shaped provider scaffold plus `hydrateResource()` seeding, so a first data-fetching component becomes reachable. Only worth starting once 1–6 have proven the comparison is useful.

## Verification

- `./equin test plugins/primitives/plugins/css/plugins/layout-harness` — the geometry suite must stay green through the theming change (it is the regression risk: seeding real tokens changes measured geometry).
- `./equin build`, then Debug → Layout Lab at `http://<worktree>.localhost:9000` — confirm the gallery renders themed, per theme × width, with mock/component side by side.
- `./equin check layout-geometry` — must still pass and still cache.
- Read the emitted gap table for `breadcrumb/overflow` and confirm each of the four outcome rows is reachable by hand-editing the mock (this is the falsification discipline the harness already uses: prove the report *bites*).

## Open questions for the user

1. **Mock form** — free-CSS JSX beside the component (assumed above), versus binding an existing prototype, versus a checked-in PNG spec (which would force a vision/pixel comparison instead).
2. **Gate or viewer** — should the signature diff fail `./equin check`, or stay a report an agent reads?
3. **Reach** — stop at prop-driven components, or fund the provider scaffold for data-fetching ones in the same pass?
