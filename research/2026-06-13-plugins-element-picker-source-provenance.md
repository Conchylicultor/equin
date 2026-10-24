# Element-picker: per-contribution + source-location provenance

## Context

When a user picks a UI element with the element-picker inspector, the emitted
`<ui-context …>` tag can only attribute the element to the nearest **slot
contribution** boundary (`data-plugin-id` / `data-slot-id`, stamped by the marker
middleware). Plain JSX composed *inside* a plugin is invisible to this.

Concrete failure that prompted this: a user picked the **"Opus 4.8" model
dropdown**. That dropdown is `LaunchControl` from `primitives/launch`, rendered as
plain JSX (`header={<LaunchControl/>}`) inside `conversations-view`'s sidebar — not
a slot contribution. So the metadata could only say
`plugin=conversations.conversations-view slot=shell.sidebar`, and an agent reading
it had to *guess* it was a model selector. We want the picker to name the exact
thing: ideally the source `file:line` it renders from, plus the semantic
contribution id when one applies.

Two complementary improvements (user asked for **both**):

- **Part A — contribution id.** Surface each slot contribution's author-supplied
  `id` (e.g. `"element-picker"`, `"header"`) in the tag. Cheap; sharpens
  slot-boundary picks. Does *not* help the LaunchControl case (not a contribution).
- **Part B — source location.** A build-time Babel JSX transform stamps every host
  element with its repo-relative `file:line` as `data-source`. The picker reads the
  nearest one and emits a `source=` attribute. Solves plain-JSX **and** slot picks
  uniformly, survives minification, no React-internals/dev-mode dependency. This is
  what would let the tag say
  `source="plugins/primitives/plugins/launch/web/components/launch-control.tsx:201"`.

**Gating requirement (user):** the source-location transform must be active only
when the element-picker plugin is part of the app's composition — *"when the app
has the pick-UI plugin, it makes paths available."* And per the repo's
collection-consumer separation rule, the consumer (the vite config) must **never
name** an individual contributor. So: element-picker *contributes* the transform
via a generic convention; the vite config consumes the generic collection;
presence of the plugin = presence of the paths.

Build facts confirmed: web build is monolithic, single `web-core/vite.config.ts`
with `react()` (no args). `@vitejs/plugin-react@4.7` supports
`react({ babel: { plugins: [...] } })`; `@babel/core` already in the lockfile.
The build is production (esbuild-minified, automatic JSX runtime) — so React-fiber
component names / `_debugSource` are **not** available at runtime, which is why a
build-time data attribute is the right mechanism rather than fiber-walking.

---

## Part A — Slot contribution id

1. **`plugins/improve/plugins/element-picker/web/internal/marker-middleware.tsx`**
   — add a third attribute to the `display:contents` span, mirroring
   `contributionKey()` in `plugins/reorder/web/internal/sorting.ts:40-43` for
   cross-plugin uniqueness:
   ```tsx
   data-contribution-id={
     contribution.id
       ? (contribution._pluginId
           ? `${contribution._pluginId}:${contribution.id as string}`
           : String(contribution.id))
       : ""
   }
   ```
   `contribution.id` is guaranteed for `defineRenderSlot` contributions (TS-required
   `id: string`) and human-meaningful. Absent only in the dispatch-slot fallback
   (`render-slot.tsx:308` synthesizes `{_slotId}`) → `""`, same as `data-plugin-id`.

2. **`…/web/internal/marker-lineage.ts`** — add `contributionId?: string` to
   `UiMarker`; in `collectMarkerLineage` read `marker.dataset.contributionId || undefined`.

3. **`…/web/internal/collect-meta.ts`** — in `collectMeta`, add
   `contributionId: innermost?.contributionId`. (Leave `formatPath` unchanged — the
   per-element id on the innermost marker is what disambiguates; don't bloat the
   lineage string.)

4. **`…/core/internal/token.ts`** — add `contributionId?: string` to
   `UiContextMeta`; emit `${attr("contribution", m.contributionId)}` in
   `serializeUiContext` (after `slot`); read `contributionId: get("contribution")`
   in `parseUiContext`.

5. **`…/core/internal/token.test.ts`** — extend the round-trip case with
   `contributionId` (and `source` from Part B).

---

## Part B — Source-location attributes (gated on element-picker presence)

### Gating mechanism — generic build contribution via a `vite/` folder

element-picker contributes a standalone Babel plugin; `vite.config.ts` discovers
all such contributions generically and applies them. No contributor is named.

- **New folder `plugins/improve/plugins/element-picker/vite/`**
  - `index.ts` — default-exports a factory `({ repoRoot }) => babelPlugin`. Zero
    `@plugins` imports (only `node:path` + babel `types` from the plugin arg), so it
    loads cleanly under Vite's esbuild config loader by **absolute file path**.
  - `source-location-babel.ts` — the visitor (imported relatively by `index.ts`).

- **Register `vite/` as a recognized plugin dir** so the boundary checker's R11
  (unknown-dir) doesn't flag it. `standardPluginDirs` auto-grows from
  `defineCollectedDir(...)` markers (per the runtime-set single-source rule — no
  hardcoded dir lists). Add a one-line internal core file:
  `…/core/internal/vite-collected-dir.ts`:
  ```ts
  import { defineCollectedDir } from "@plugins/framework/plugins/tooling/plugins/collected-dir/core";
  export const viteCollectedDir = defineCollectedDir("vite");
  ```
  Codegen will emit a `core/vite.generated.ts` registry (owner = element-picker).
  We do **not** consume that generated registry from vite.config (its dynamic
  imports use the `@plugins` alias, which the esbuild config loader can't resolve —
  the same constraint the lint plugin hit with jiti). It's harmless and documents
  the collection; `plugins-registry-in-sync` will keep it current via `build`.

- **No `boundary-config.ts` edit.** `runtimeNames` (web/server/central/core/shared)
  governs the cross-plugin import grammar (R4); nothing imports `@plugins/.../vite`
  across boundaries (vite.config loads it by absolute fs path, not the alias), so
  `vite/` is *not* a cross-plugin runtime and must not be added there.

### The Babel transform (custom, ~30 lines — no new dependency)

`JSXOpeningElement` visitor:
- Only host elements: `name.type === "JSXIdentifier" && /^[a-z]/.test(name.name)`
  (skips components like `LaunchControl`, `Fragment`).
- Skip if a `data-source` attr already exists (idempotent across HMR).
- `value = \`${posixRelative(repoRoot, state.filename)}:${node.loc.start.line}\``
  — one combined attribute, line only (drop column) to minimize DOM/bundle weight.
- Push `t.jsxAttribute(t.jsxIdentifier("data-source"), t.stringLiteral(value))`.

Host-only stamping is exactly right: `<LaunchControl/>` isn't stamped, but the
`<button>`/`<div>` *inside* `launch-control.tsx` are — so picking the Opus 4.8
dropdown resolves to `launch-control.tsx:NNN`. Existing
`babel-plugin-transform-react-jsx-source` only sets dev-mode `__source` props
consumed by React internals (stripped in prod) — not a DOM attribute — so a custom
plugin is the correct minimal choice.

### vite.config consumption

**`plugins/framework/plugins/web-core/vite.config.ts`** — make config async, glob
the generic convention, import each by absolute path, pass to react's babel:
```ts
export default defineConfig(async () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const pluginsRoot = path.resolve(__dirname, "../../../");
  const babelPlugins: unknown[] = [];
  for (const rel of await findViteContributions(pluginsRoot)) {  // **/vite/index.ts
    const mod = await import(path.join(pluginsRoot, rel));        // absolute → no @plugins alias
    babelPlugins.push(mod.default({ repoRoot }));
  }
  return {
    root: path.resolve(__dirname, "./web"),
    plugins: [react({ babel: { plugins: babelPlugins } }), tailwindcss()],
    define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(process.env.VITE_BUILD_ID ?? "dev") },
    build: { outDir: path.resolve(__dirname, process.env.VITE_OUT_DIR || "dist"), emptyOutDir: true },
    resolve: { alias: { "@plugins": path.resolve(__dirname, "../../../") } },
  };
});
```
- `vite.config.ts` lives in a `compositionRoot` plugin → exempt from boundary
  structural rules; the fs walk + absolute-path import are not `@plugins` imports.
- Use a small `readdirSync` walk (pattern already in `plugin-registry-gen.ts` /
  `plugin-dirs.ts`) excluding `node_modules`/`dist` — version-safe, zero-dependency
  (avoid relying on `fs/promises.glob`'s Node-version floor).
- Build-time one-shot discovery (not runtime polling) — compatible with the
  no-polling rule.

### element-picker read side

**`…/web/internal/collect-meta.ts`** — add `nearestSource(el)`: walk `closest("[data-source]")`,
skipping the middleware's own `display:contents` span (reuse existing `isMarkerSpan`,
line 40-42 — that span is JSX in `marker-middleware.tsx` so it also carries a
`data-source`). Add `source: nearestSource(el)` to `collectMeta`.

**`…/core/internal/token.ts`** — add `source?: string` to `UiContextMeta`; emit
`${attr("source", m.source)}`; parse `source: get("source")`.

**`…/CLAUDE.md`** — document the new `contribution=` and `source=` attributes in the
Token format section.

---

## Edge cases / risks

- **Marker/overlay self-stamping.** The middleware span and picker-overlay JSX get
  `data-source` too; read side skips marker spans via `isMarkerSpan`, and overlay
  targets are already excluded (`[data-element-picker]`).
- **Public/prod build.** `data-source` is fine for the agent-facing Studio build but
  bloats a future public `equin.ai` build. The plugin-presence gating already gives
  one off-switch (drop element-picker from that composition); a `VITE_SOURCE_LOCATIONS`
  env guard inside the factory is an easy second knob. Note as follow-up, not blocker.
- **Bundle size.** One short repeated-prefix string per host element; gzips well.
- **`contribution.id` typing** is `unknown` on `Contribution`; coerce with `String(...)`
  as `contributionKey()` does.
- **Gating correctness.** Remove element-picker → no `vite/` folder → glob finds
  nothing → `react()` runs with no extra babel plugin → no `data-source`. ✔

---

## Critical files

- `plugins/framework/plugins/web-core/vite.config.ts` (modify — async + discovery)
- `plugins/improve/plugins/element-picker/vite/index.ts` (new — babel factory)
- `plugins/improve/plugins/element-picker/vite/source-location-babel.ts` (new — visitor)
- `plugins/improve/plugins/element-picker/core/internal/vite-collected-dir.ts` (new — `defineCollectedDir("vite")`)
- `plugins/improve/plugins/element-picker/web/internal/marker-middleware.tsx` (modify)
- `plugins/improve/plugins/element-picker/web/internal/marker-lineage.ts` (modify)
- `plugins/improve/plugins/element-picker/web/internal/collect-meta.ts` (modify)
- `plugins/improve/plugins/element-picker/core/internal/token.ts` (modify)
- `plugins/improve/plugins/element-picker/core/internal/token.test.ts` (modify)
- `plugins/improve/plugins/element-picker/CLAUDE.md` (modify — token format docs)

## Verification

1. **Unit:** `bun test plugins/improve/plugins/element-picker/core/internal/token.test.ts`
   — `contribution` and `source` round-trip.
2. **Build:** `./equin build` — codegen emits `core/vite.generated.ts`; vite
   picks up the babel plugin. Confirm `plugin-boundaries` + `plugins-registry-in-sync`
   pass (`./equin check`).
3. **DOM sanity:** in the running app, inspect the LaunchControl `<button>` — it
   should carry `data-source="plugins/primitives/plugins/launch/web/components/launch-control.tsx:NNN"`.
4. **End-to-end (Playwright):** open the picker (`MdAdsClick`), click the "Opus 4.8"
   dropdown, submit, and assert the inserted `<ui-context …>` chip now contains
   `source="…/launch-control.tsx:NNN"` (previously only `plugin=…conversations-view slot=shell.sidebar`).
