# App icon families + app-only glyphs

## Context

Prototype `proto-1792113547-2qr6g7` (Sonata song view) draws its own icon set:
37 hand-drawn 24-unit glyphs, outline (1.7 stroke, round caps/joins), one
filled (play). The app can only draw Material Symbols (or their Lucide
counterpart in a `lucide` scope — Sonata's theme sets `iconFamily: "lucide"`
today), so it cannot match. Two needs:

1. **Restyled common glyphs** (close, chevron, play, pause, volume, eye, check,
   add…) — every `symbol("…")` drawn in a Sonata scope, shared chrome included,
   should wear Sonata's drawing.
2. **Domain glyphs with no Material name** (piano roll, swing, metronome, guitar
   pick, chord stack, current key, circle of fifths, progression, transpose) —
   Sonata today borrows generic Material names (`music-note` stands for
   notation, MIDI, UG and the current chord at once), so mapping those names
   would be wrong; Sonata needs to NAME its own glyphs.

## Design

### Icon families become an open, web-side contribution

The `lucide` family is today a closed special case (`ICON_FAMILIES` in
`icons/core/style.ts`, `style.family === "lucide"` in
`web/internal/icon-drawing.ts`). Open it:

- **`Icons.Family` slot** (icons `web/slots.ts`): `{ family: IconFamily }`.
  A family is web-only data — what draws, never how a scope chooses it:
  - `id`, `label`, `fallback?: string` (another family id; the chain ends at
    Material, the built-in base, which is not a contribution);
  - `drawing`: `{ kind: "sprite", key, has(name) }` (server-built sprite,
    fetched on first use — Lucide) or `{ kind: "inline", glyphs, symbols }`
    (an app family: glyph bodies ship in its own web bundle, rendered into the
    sheet as `<symbol id="fam-<family>-<glyph>">`).
- **Lucide is one contributor**: icons web contributes
  `{ id: "lucide", drawing: { kind: "sprite", key: LUCIDE_SPRITE, has: lucideNameOf } }`.
  Its server sprite build (`sprites/server/internal/lucide.ts`) is unchanged.
- **`IconStyle.family` is a string** (`IconFamilyId`). `readIconTokens`
  validates its spelling only; the customizer's Family picker lists
  `material` + every registered family.
- **Family store** (`web/internal/family-store.ts`, page-global like the sprite
  store): `IconFamilyHost`, an `Icons.Root` companion in icons web, reads
  `Icons.Family.useContributions()`, publishes them in a layout effect (icons
  re-render before paint — no flash) and renders the inline families' symbols.
- **Resolution of `symbol(name)` in family F** (`resolveIconDrawing`): walk
  F → F.fallback → … ; the first family that draws `name` wins — inline: drawn
  at once; sprite: drawn once loaded, else wanted and the walk falls to
  Material (today's Lucide behaviour). A family not (yet) registered is
  skipped — its plugin may load in a later tier; the Material drawing stands in.

### App-only glyphs: the `custom` IconRef kind

- `defineIconFamily({ id, label, fallback, glyphs, symbols })` in icons
  **core** (import-free, any runtime) returns an `InlineIconFamily<G>` whose
  `icon(name: G)` mints `{ kind: "custom", family, name }` — the glyph names
  are the `glyphs` keys, so a typo is a tsc error, and `symbols` (a
  `Partial<Record<SymbolName, G>>`) is checked the same way.
- A glyph is `{ body, paint?: "stroke" | "fill" }`; the family carries a
  `stroke` width. The sheet wraps each body in one `<g>` carrying the paint
  (`fill="none" stroke="currentColor" stroke-width stroke-linecap/linejoin round`,
  or `fill="currentColor"`), so callers need no CSS. Bodies are validated at
  define time (shape elements only — anything else throws).
- A custom ref draws its family's glyph in EVERY scope (like a brand: one
  style); until its family registers it is an empty box at its final size.
- Not manifest-scanned and outside `icons/literal-icon-name`: the whole family
  ships with its plugin, so there is nothing to tree-shake.

### Sonata contributes the `sonata` family

New plugin `plugins/apps/plugins/sonata/plugins/icons/`:
- `core/` — `sonataIcons = defineIconFamily({ id: "sonata", fallback: "lucide", stroke: 1.7, glyphs: <the prototype's 37>, symbols: { close: "x", "keyboard-arrow-down": "down", "play-arrow": "play", … } })`.
- `web/` — `Icons.Family({ family: sonataIcons })`.
- Sonata's theme (`sonata/shell/web/internal/theme.ts`) sets `iconFamily: "sonata"`.
- Domain call sites switch to `sonataIcons.icon("…")`: piano roll, notation,
  current chord, progression, chord list, current key, circle of fifths,
  metronome, Ultimate Guitar, swing/feel.

## Deviations from the first sketch

- No new `icons/` leaf folder kind: a family's glyphs are plain data in its
  `core/` (tens of glyphs; codegen and a folder vocabulary row would buy
  nothing a `glyphs` record's keys don't already give tsc).
- Lucide's sprite stays server-built; only its web registration moves onto the
  contribution.

## Critical files

- `plugins/ui/plugins/icons/core/{style.ts,icon-ref.ts,icon-family.ts,index.ts}`
- `plugins/ui/plugins/icons/web/{slots.ts,index.ts}`, `web/internal/{icon-drawing.ts,icon-markup.ts,family-store.ts,family-host.tsx}`
- `plugins/ui/plugins/tokens/plugins/icons/{core/group.ts,web/components/icons-section.tsx}`
- `plugins/apps/plugins/sonata/plugins/icons/**` (new), Sonata theme + section call sites.

## Verification

- `./singularity test plugins/ui/plugins/icons` (resolver: family chain, inline
  vs sprite, custom kind, unregistered family).
- `./singularity build`; screenshot a Sonata song (`/sonata/song/<id>`) and
  compare its rail / transport icons against the prototype.
