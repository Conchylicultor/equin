# Split the `typography` token group into `font-family` + `type-scale`

_2026-06-11 · category: global (theming / tokens)_

## Context

The `typography` token group
(`plugins/ui/plugins/tokens/plugins/typography/shared/group.ts`) bundles two
orthogonal concerns into one switchable group:

- **Font identity** — `fontSans`, `fontSerif`, `fontMono`, `letterSpacing`
  (`--font-sans`, `--font-serif`, `--font-mono`, `--letter-spacing`).
- **Type scale** — the role-based size/line-height scale + weights + legacy
  kebab sizes (20 keys: `font-size-*`, `line-height-*`, `fontWeight*`,
  `fontSize{Title…Caption}`, `lineHeight{Title…Caption}`).

Because a token group is switched as a unit, selecting a color/font theme that
legitimately carries only font families (any tweakcn community theme) also
selects a `typography` preset. tweakcn presets are **sparse** — they only set
`fontSans/Serif/Mono` (+ `letterSpacing`) and say nothing about sizes. Before
the sparse-override merge base landed this silently dropped the scale; now the
scale falls back to schema defaults — but it is still *wrong* that a font theme
has any relationship to the type scale at all. A color/font theme must have **no
power** over the type scale.

**Outcome:** the size/line-height/weight scale is owned by its own group,
selectable independently of font-family theming, and never named or perturbed by
a theme that has no opinion on sizing.

### Dependency — already landed

This builds on the **sparse-override merge base** (`mergeGroupValues`,
commit `070ae6258`) and the **single-owner CSS-var guard** (`bcd9945a6`), both in
HEAD as of 2026-06-11. The merge precedence is `schemaDefaults < preset <
config overrides`, so each new group's schema defaults guarantee a complete var
set regardless of preset sparsity. No further merge work is needed.

## Design

Retire `plugins/ui/plugins/tokens/plugins/typography/` and replace it with two
sibling token-group plugins, each structurally identical to the existing
`density` group (the canonical independent group):

| New plugin | Group id | Schema keys | CSS vars |
|---|---|---|---|
| `font-family` | `font-family` | `fontSans`, `fontSerif`, `fontMono`, `letterSpacing` | `--font-sans`, `--font-serif`, `--font-mono`, `--letter-spacing` |
| `type-scale` | `type-scale` | the other 20 keys (unchanged) | `--font-size-*`, `--line-height-*`, `--font-weight-*` |

CSS var names are **unchanged** (`defineTokenGroup` derives them from the schema
keys, which keep their names). Every consumer that reads vars via Tailwind
(`<Text>`, `font-sans`, etc.) is therefore untouched — only the *grouping/owner*
changes. The `css-vars-single-owner` guard stays satisfied: each var moves to
exactly one new owner, none is declared twice.

`letterSpacing` lives in **`font-family`** (not `type-scale`): tweakcn writes
`tracking-normal` → `letterSpacing`, and the whole point is that a tweakcn theme
touches only the font group. Putting tracking anywhere tweakcn writes guarantees
tweakcn never reaches `type-scale`.

### The crux: tweakcn must target `font-family`, not `type-scale`

`plugins/ui/plugins/tweakcn/core/convert.ts` (~line 125–144) currently emits
`result["typography"] = { fontSans/Mono/Serif, letterSpacing }`. Change the key
to `result["font-family"]`. It already only emits the four font-identity keys,
so after the rename a tweakcn theme produces a preset for `font-family` **only**
— `type-scale` is never named in the converter's output and keeps whatever the
user selected. This is the structural fix that makes the conflation impossible,
not just harmless.

## Files to change

### 1. New plugin `plugins/ui/plugins/tokens/plugins/font-family/`

Mirror `density`'s shape (`plugins/ui/plugins/tokens/plugins/density/`) and the
old typography files:

- `package.json` — name `@singularity/plugin-tokens-font-family` (match density's
  naming convention).
- `shared/group.ts` — `defineTokenGroup("font-family", { fontSans, fontSerif, fontMono, letterSpacing })` with the existing defaults. Export `FontFamilyTokenValues`.
- `shared/config.ts` — copy typography's `config.ts`, `scope: "app"`,
  `preset` dynamicEnum (default `"default"`) + `overrides` object over the 4
  keys. Export `fontFamilyConfig`.
- `shared/index.ts` — re-export group, `FontFamilyTokenValues`, `fontFamilyConfig`.
- `web/slots.ts` — `FontFamily.Preset` slot at `ui.font-family.preset`,
  `FontFamilyPresetContribution`.
- `web/presets.ts` — single `default` preset with the 4 font-identity values.
- `web/internal/config.ts` — re-export shim.
- `web/components/font-family-picker.tsx`, `font-family-section.tsx` — copied
  from typography's picker/section, trimmed to the 4 keys (the `Aa`
  font-family swatch is already font-identity-appropriate).
- `web/index.ts` — register `FontFamily.Preset` defaults, `ConfigV2.WebRegister`,
  `DynamicEnum.Options` (using `useTokenGroupPresets("font-family")`),
  `ThemeEngine.TokenGroup` (id `font-family`, label `Fonts`),
  `ThemeEngine.VariantGroup`, `ThemeCustomizer.Section`.
- `server/index.ts` — `ConfigV2.Register({ descriptor: fontFamilyConfig })`.
- **Move** the `google-fonts` sub-plugin tree here →
  `plugins/ui/plugins/tokens/plugins/font-family/plugins/google-fonts/`. Update
  its loader import (`google-fonts-loader.tsx`) from `typographyConfig` /
  `useTokenGroupPresets("typography")` to `fontFamilyConfig` /
  `useTokenGroupPresets("font-family")`. No other change — it already reads only
  `fontSans/Serif/Mono`.
- `CLAUDE.md` — prose stub (autogen block fills on build).

### 2. New plugin `plugins/ui/plugins/tokens/plugins/type-scale/`

- `package.json` — `@singularity/plugin-tokens-type-scale`.
- `shared/group.ts` — `defineTokenGroup("type-scale", { …20 keys… })` with
  existing defaults. Export `TypeScaleTokenValues`.
- `shared/config.ts` / `shared/index.ts` — as above, `typeScaleConfig`.
- `web/slots.ts` — `TypeScale.Preset` at `ui.type-scale.preset`.
- `web/presets.ts` — single `default` preset with the 20 scale values.
- `web/internal/config.ts`, `web/components/type-scale-picker.tsx`,
  `type-scale-section.tsx` — copied/trimmed from typography. The picker swatch
  should preview *size* (e.g. an `Aa` rendered at `fontSizeBody`) rather than
  font family, since this group no longer carries a family.
- `web/index.ts` — registrations, id `type-scale`, label `Type Scale`.
- `server/index.ts` — `ConfigV2.Register`.
- **Move** the lint rule `lint/no-arbitrary-font-size.{ts,test.ts}` here (it
  bans arbitrary sub-12px `text-[Npx]` — a type-scale concern). Update
  `lint/index.ts` `name` to `tokens-type-scale` (or per convention). Lint rules
  are repo-wide regardless of host plugin, so behavior is unchanged.
- `CLAUDE.md` — prose stub.

### 3. Delete `plugins/ui/plugins/tokens/plugins/typography/`

Remove the whole tree once the two replacements exist (group, config, slots,
presets, components, server, lint, google-fonts, CLAUDE.md, package.json).

### 4. `plugins/ui/plugins/tweakcn/core/convert.ts`

Rename the emitted key `result["typography"]` → `result["font-family"]`
(~line 144). Update the section comment. No value-mapping change.

### 5. `plugins/ui/plugins/tokens/web/index.ts` (global presets)

In each of the three `ThemeEngine.GlobalPreset` `groups` maps (`default`,
`ocean`, `warm`), replace `typography: "default"` with two entries:
`"font-family": "default"` and `"type-scale": "default"`.

### 6. Generated registries & docs (via build, not hand-edited)

`web.generated.ts`, `server.generated.ts`, `lint.generated.ts`,
`token-group-vars.generated.ts`, and the per-plugin `CLAUDE.md` autogen blocks +
`docs/plugins-*.md` are all regenerated by `./equin build`. Adding the two
plugin folders and deleting `typography` is picked up automatically. Run build,
then commit the regenerated artifacts.

### Config migration note

Existing stored configs under the old `typography` storePath become orphaned
(group id no longer exists). Default behavior is safe — both new groups default
to the `default` preset with empty overrides, which equals the prior visual
result. The one observable reset: any worktree that had applied a tweakcn theme
will lose the *stored* font selection on first load (its `typography` preset
pointer is dead), and any manual typography token overrides reset to default.
Acceptable for this refactor; no migration code. Re-applying the tweakcn theme
restores fonts and now correctly leaves the scale untouched.

## Verification

1. `./equin build` — confirms codegen regenerates the registries/manifest,
   migrations unaffected, and the app boots.
2. `./equin check` — must pass, in particular `css-vars-single-owner`
   (each var owned once), `css-vars-supplied`, `token-group-vars-in-sync`,
   `plugins-doc-in-sync`, `type-check`, `eslint` (the moved
   `no-arbitrary-font-size` rule still active repo-wide), and
   `plugin-boundaries`.
3. App at `http://<worktree>.localhost:9000` → open the theme customizer
   (theme-engine settings pane): confirm **two** sections now appear — "Fonts"
   and "Type Scale" — each with its own preset picker + token rows.
4. Independence test (the core outcome):
   - Set a custom Type Scale override (or, once present, a second scale preset).
   - Apply a tweakcn community theme via the community-browser.
   - Confirm the fonts change but the type-scale override **persists**
     (inspect `--font-size-body` etc. stay at the chosen values; only
     `--font-sans`/`--letter-spacing` change). Use `e2e/screenshot.mjs` to drive
     the apply and capture before/after, and inspect computed CSS vars.
5. Google Fonts still load: pick a tweakcn theme using a Google web font (e.g.
   Geist) and confirm the `<link data-google-font>` tags appear and text renders
   in the font — proving the relocated `google-fonts` sub-plugin reads
   `font-family` config correctly.
