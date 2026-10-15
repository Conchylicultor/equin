# Token usage as closure edges

## Context

A served composition is the **hard closure** of its entries, and a hard edge exists only
where a plugin imports another, in the same runtime folder (`cross-refs` facet,
`facets/plugins/cross-refs/facet/index.ts:156`). Token-group variables are consumed
without any import:

- `primitives.avatar` paints `bg-linear-140/srgb from-categorical-1-deep …`. The Tailwind
  class resolves through `@theme inline` in `ui-kit/web/theme/app.css`
  (`--color-categorical-1: var(--categorical-1)`).
- `--categorical-1` exists only once `ui.tokens.categorical/web` contributes
  `ThemeEngine.TokenGroup`.
- Nothing imports that web half, so it never enters a bundle. The theme engine then
  drops any fragment for an unregistered group (`resolve-theme.ts`, `unregistered-group`).
  equin.ai's app tiles rendered blank because of this (fixed by hand in `7fc089a12f`).
- `--chart-*` had the same incident: the website theme imports `chartGroup` from
  `chart/core`, but a `web` import of a `core` barrel makes no edge.

Today `served-baseline` (`plugins/plugin-meta/plugins/composition/core/config.ts`)
hand-lists `ui.theme-engine` and nine `ui.tokens.*`. Each entry was added after a
production incident, and the next token-group consumer will repeat the story.

**Goal:** "plugin P uses a variable owned by token group G" becomes a hard edge
P → owner(G), derived from code. The token entries leave `served-baseline`, and a new
consumer can no longer ship without the plugin that defines its variables.

## Design

### 1. Token ownership: static and cross-checked

Facet `extract` is sync and reads only the FS snapshot (no barrel import; the tree is built
`skipBarrelImport`, before `generateTokenGroupVars` runs in `regen-pipeline.ts:225`). So
ownership is read **statically**:

- **Owner:** the plugin whose `core/` contains `defineTokenGroup("<id>", { … })`.
  Located with `findMarkerCalls` (`plugin-meta/plugins/parse-utils/core`).
- **Vars:** `--${camelToKebab(key)}` for each literal key of the schema object. This is
  the same rule as `define-token-group.ts:67`. Export `camelToKebab`/`tokenVarName` from
  theme-engine core so there is one spelling.
- All 16 groups today use a literal object with literal keys.

Drift guard (rung 3):

- Extend the existing `token-group-vars-in-sync` check. The static owner/vars map must
  equal what `collectTokenGroupVars` (barrel-imported, the runtime truth) reports.
- It must also confirm that the **defining** plugin is the **registering** plugin. The
  generator's loop already knows `node.dir`, so record it.
- A non-literal schema (spread, computed key) fails this check loudly. It can never
  silently lose edges.

### 2. Token usage: an extra field on the `cross-refs` facet

A token variable is a reference to another plugin, which is exactly what `cross-refs`
records. Adding a field avoids a new facet and its three mandatory render sub-plugins
(`facets:render-complete`).

`CrossRefsData` gains `tokenUses: { plugin: PluginId; group: string; vars: string[] }[]`.

**Extract.** Scan the plugin's shipped runtime folders (`SHIPPED_RUNTIME_FOLDERS`; tests
are skipped by `walkFiles`) for `.ts`, `.tsx` and `.css`, and collect two kinds of usage:

- **Literal `var(--x)`** anywhere in the text (CSS, and arbitrary values like
  `bg-[var(--chart-1)]`).
- **Tailwind classes:**
  - Find the classes per file with `@tailwindcss/oxide`
    `Scanner.getCandidatesWithPositions({ content, extension })`. This is sync and native,
    and the same extractor the global CSS pass uses.
  - Resolve each class with Tailwind's own design system:
    `__unstable__loadDesignSystem(appCss)` → `design.candidatesToCss(candidates)`, then
    take the `var(--x)` occurrences in the output.
  - `@theme inline` emits the token variable directly
    (`oklch(from var(--categorical-1) …)`, verified in the deployed CSS). So
    `@theme inline` aliases, `@utility` bodies (`rounded-card` → `--radius-card`),
    variants and `/15` opacity modifiers all resolve exactly as in the real stylesheet,
    with no hand-written parser.
  - Load the design system once per root, by top-level await in a codegen-core helper
    (`loadTokenUtilityResolver(root)`, reading `appCssPath` from
    `codegen/core/app-css-utilities`). Memoize candidate → vars.
  - The API is `__unstable__`, the same one prettier-plugin-tailwindcss and IntelliSense
    use. Pin `tailwindcss` exactly in the owning plugin's `package.json`. A unit test
    on known classes (below) catches a breaking upgrade.

**Relate.**

- Map each var to its owner using the static ownership from §1, computed once per tree.
- Skip self-references and vars no group owns. The rest (`--tw-*`, `--avatar-fill`,
  non-token CSS vars) are ignored.
- Write the uses grouped per owner plugin.
- Doc render: the existing cross-refs section lists "Uses tokens: `ui/tokens/categorical`
  (categorical-1…10)". This shows up in the plugin CLAUDE.md files and the
  `plugins-details.md` reverse index ("who uses my tokens").

### 3. Closure edge

In `classifyEdges` (`plugin-meta/plugins/closure/core/classify-edges.ts`, after the import
block at `:78-89`):

- For each `tokenUses[i]`, `pushUnique` into `hardForward` / `hardReverse`.
- Everything downstream inherits it unchanged: `hardClosure`, negation cascade,
  `explainInclusion`, `impactOf*`, `composition-closure`, the registry codegen and
  Studio.
- `Edge` gains an optional `via: "import" | "token"`. It is serialized in
  `serialize.ts` (both directions).
- Studio's inclusion path can then say "included because `primitives.avatar` uses
  `--categorical-*`" instead of naming a phantom import.

### 4. Shrink `served-baseline`

Remove `ui.theme-engine`, `ui.tokens.color-palette`, `density`, `shape`, `type-scale`,
`font-family`, `sidebar-palette`, `shadow`, `chart` and `categorical`, together with
their incident comments.

- `ui.theme-engine` is still reached, because every token plugin imports `ThemeEngine`.
- **Stays:** `ui.tokens.icons` and `ui.icons.sprites` (not var-driven: a JS bridge
  and a Core.Root sprite host), plus `apps-core.layout`, `infra.health`, `shell.toast`,
  `reorder` and `overscroll-hint`. See *Follow-up*.
- Replace the tests in `composition/core/config.test.ts` that pinned these entries.
  Add a closure test: resolving the `website` composition contains
  `ui.tokens.categorical` and `ui.tokens.chart` with no baseline entry naming them.

## Critical files

- `plugins/plugin-meta/plugins/facets/plugins/cross-refs/{core/types.ts,facet/index.ts}`: `tokenUses` extract/relate, plus its doc render.
- `plugins/framework/plugins/tooling/plugins/codegen/core/`:
  - a new `token-ownership.ts`: static `defineTokenGroup` parse.
  - a new `token-utility-resolver.ts`: oxide plus the design system.
  - `token-group-vars-gen.ts`: record the registering plugin.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/token-group-vars-in-sync/`: static == imported, definer == registrar.
- `plugins/plugin-meta/plugins/closure/core/{types.ts,classify-edges.ts,serialize.ts}`: the `via` field and the token edges.
- `plugins/ui/plugins/theme-engine/core/define-token-group.ts`: export the var-name rule.
- `plugins/plugin-meta/plugins/composition/core/{config.ts,config.test.ts}`: the baseline shrink.
- `plugins/plugin-meta/plugins/facets/plugins/cross-refs/` package.json: add the `@tailwindcss/oxide` and pinned `tailwindcss` deps (or wherever the resolver ends up).

## Verification

1. **Unit:** the resolver maps these classes to these vars:
   - `from-categorical-1-deep`, `bg-categorical-4/15`, `hover:text-chart-2` →
     `--categorical-1`, `--categorical-4`, `--chart-2`
   - `rounded-card` → `--radius-card`
   - a plain word like `folder` in prose → nothing
   - `bg-[var(--avatar-fill)]` → `--avatar-fill`, which the owner filter then drops

   Static ownership equals `collectTokenGroupVars` for all 16 groups.
2. **classifyEdges test:** `primitives.avatar` has hard edge → `ui.tokens.categorical`;
   `apps.website.*` → `ui.tokens.chart`.
3. **Bundle diff:** a one-off `./singularity run` script resolves every committed
   composition with the old and the new graph and config.
   - Expect: for each composition, `after ⊇ before`. Everything that leaves the
     baseline is re-derived.
   - The script prints the additions so over-inclusion is visible and judged.
   - The additions should be token plugins only.
4. `./singularity build`. All checks pass, including `composition-closure`,
   `token-group-vars-in-sync` and `plugins-doc-in-sync`.
5. **Real served page:**
   - Serve the `website` composition and check that its HTML preloads
     `ui.tokens.categorical.web` and `ui.tokens.chart.web`.
   - `screenshot.ts --composition website --path /website/apps` shows coloured app tiles.

## Follow-up (separate plan): runtime companions that are not tokens

`ui.icons.sprites`, `ui.tokens.icons` (its bridge) and `reorder` are also consumed
without an import. In each case the **capability owner** is the natural declarer, but it
cannot import the provider without a cycle:

- `ui.icons` sits below live-state.
- `slot-render` is below `reorder`.

The candidate primitive is a **pulling slot**: the owner declares a slot whose
contributors are hard-pulled whenever the owner is bundled. It reuses the soft
contribution edge and only upgrades it, and it is a `SlotMeta` flag in
`slot-declaration`.

Examples: `ui.icons` owns `Icons.SpriteSource` (contributed by sprites) and
`slot-render` owns `SlotRender.ListMiddleware` (contributed by reorder).

`apps-core.layout`, `infra.health` and `overscroll-hint` are requirements of
*being served*, not of any capability, so they stay in `served-baseline`.

`shell.toast` is likely already derived through `infra.health`'s `showToast` import.
Verify that with the bundle diff and drop it then.
