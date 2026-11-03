# Gallery "poster" card + excerpt slot (Places photo gallery)

## Context

The Places side panel's gallery is hard to read (screenshot, 2026-11-03): a 16/10 photo fills
the 372 px panel's width, then the name, the address and the tags each drawn with their
field-type icon (`Tt`, the tag outline). Want to go / Been show twice: as `— ✓` flags after the
name and as pills on the photo. The user's **note is not shown at all**. The user picked the
`gallery: photo` direction of **proto-1792633470-xjmmji**:

- one wide photo per place, its name and `type · place` written on the photo over a dark
  gradient (scrim);
- under it, the note (up to 3 lines, set off by a rule on its left), then the tag chips;
- one column in the panel; the photo zooms slightly on hover; a selected card gets a ring.

## Is the primitive flexible enough? Partly

What `data-view/gallery` already does:

| Prototype need | Already there |
|---|---|
| Photo cover, zoom on hover, selected ring | `CoverFrame` with the `coverZoom` token, and `selected` |
| Status pills on the photo | `PlaceCover` draws them itself |
| Hover linked with the map pins | `hoveredRowId` / `onRowHoverChange` |
| Tags as chips under the card | `trail` tokens |

What it **cannot** express today:

1. **Text written on the photo.** `DataCard` always puts `CardMeta` under the cover.
   `GalleryViewOptions.card` is a closed set (`cover | panel`) and has no caption-on-cover
   shape.
2. **A long text block (a note or description).** The card has three fixed one-line rows. A
   `prose` field lands in `line2`, joined by ` · ` with the address. Clamping it to several
   lines is the *theme-wide* `cardSubtitleLines`. No slot means "a paragraph, clamped to a few
   lines".
3. **Type icons on chips.** `CardTokens` draws the field type's icon before every token,
   including fields whose cell is already a chip (the tags). This is where the tag-outline
   icon in the screenshot comes from.

By design (the gallery CLAUDE.md), a surface never replaces the card's body. So the fix is to
extend the primitive's own vocabulary rather than add a Places-only card.

## Design

### 1. A new placement slot: `excerpt` (data-view core)

- Add `"excerpt"` to `SLOTS` and `SLOT_RANK` (after `line2`, before `trail`) in
  `plugins/primitives/plugins/data-view/core/internal/placement.ts`.
- It means: a paragraph, wrapped, clamped to `cardExcerptLines` lines (a new
  `ui/tokens/data-view` token, default 3), in the subtitle ink.
- Recipes `record`, `inbox` and `timeline` gain the rule `["prose", "excerpt"]` *before* their
  `["prose", "line2"]`. The engine already falls through to the next rule when a view does not
  declare a slot, so the list and the table keep putting prose in `line2`. Only views that
  declare `excerpt` (the gallery) change.
- The Properties slot editor gets a band for it for free: it reads `ViewSlots`.
- **Audit step:** check every gallery consumer (prototypes gallery, deploy sites, events,
  theme gallery, sonata, …) for a *visible* `prose` field (multiline-text or json kind). If one
  exists, its prose moves from the subtitle into an excerpt. Either accept that, or pin it back
  with `place: { x: "line2" }`.

### 2. A new card shape: `card: "poster"` (gallery)

Add it to `GalleryViewOptions` in `gallery/web/internal/options.ts`, beside `cover` and `panel`:

- **On the cover:** a bottom scrim layer (a new `coverScrim` token, a gradient to about 60 %
  black). Over it, pinned bottom-left: the title line, the `afterTitle` marks and the `line2`
  subtitle, in on-cover ink (new tokens `cardOnCoverInk` and `cardOnCoverSubtleInk`).
- **Under the cover:** the `excerpt` block, then `CardTokens`.
- **Kept the same:** the badge (top-left), the actions cluster (top-right), the primary
  (bottom-right, which sits above the caption), selection, hover, `dimmed` and activation. It
  stays the same `DataCard` construction site.
- **Implementation:** `DataCard` takes a `caption?: ReactNode`, drawn inside the `CoverFrame`
  over the scrim. `CardMeta` gets two parts: `<CardCaption>` (title, marks, subtitle) and
  `<CardBody>` (excerpt, tokens). The `cover` shape keeps calling the whole `CardMeta`, so its
  output does not change.
- **Grid minimum:** the theme's `--gallery-card-min` (13.75rem by default) is kept. The 372 px panel already fits only one card per row, so the poster shape needs no minimum of its own.
- **Height:** an excerpt is drawn only when the row has one. Poster cards therefore vary in
  height, and grid rows align to the top. This is a deliberate break from the "same height"
  rule of the `cover` shape: a note is the point of this shape, and reserving 3 empty lines
  under every note-less place is what the prototype avoids. Windowing still works because
  `VirtualRows` measures each line.
- **Parts:** add `dv.card-caption`, `dv.card-excerpt` and `dv.cover-scrim` to
  `DATA_VIEW_PARTS`.

### 3. A chip token draws no type icon (data-view `CardTokens`)

`CardTokens` skips the type icon when `useIsChipField(field)` is true. A chip already shows
what it is (colour, label). This is a generic rule: no field type is named.

Impact on existing galleries, audited (`trail` tokens only; the `edge` never had an icon):

- No change: Sonata library (chords, composer, plays), Prototypes (versions), Deploy sites
  (commit).
- Events gallery: the `category` enum chip loses its icon.
- Theme gallery: the `tags` and `usedBy` chips lose their icons.

All three are chips with a label, so the icon in front adds nothing.

### 4. Places adopts it

- `places-panel.tsx`: pass `viewOptions={{ gallery: { card: "poster" } }}` (typed with
  `satisfies GalleryViewOptions`, as `sites-index.tsx` does).
- `places-map/web/internal/fields.tsx`: add a derived `kind` field, the place's type in words
  (`primaryType.replaceAll("_", " ")`, the same spelling as `place-card.tsx`; consider a small
  shared `placeTypeLabel` there). Its value is `null` for a custom place.
- `note` becomes `prose`. Either switch its field to the multiline-text type (the same text
  column, but a schema-type change: check `migrations-in-sync`), or pin it in the panel config
  with `"slot": "excerpt"`. **Prefer pinning in config**: it changes no storage, and the note
  is already edited in the place card.
- `config/apps/places/places-map/places.panel.jsonc`, gallery `properties`:
  - `name` goes in the title;
  - `kind` and `address` go in `line2`, so the subtitle reads `type · address` (the address
    truncates);
  - `note` goes in `excerpt`;
  - `tags` stay in `trail`;
  - `want`, `been` and `glyph` are hidden. Status already shows as the cover's pills, which
    removes the `— ✓`.

  The list view's config is unchanged.
- Tags draw as tinted `PlaceTagChips` in BOTH views (user, 2026-11-03: consistent, chips everywhere): `PlaceTagsCell` drops its quiet branch (`QuietPlaceTags`), so the list's tags line shows the same chips as the gallery. Check that the list row's second line still fits at 372 px (chips are taller than quiet text).
- A place with no photo keeps its `PlacePhotoWash` with the large icon. The scrim keeps the
  caption readable over the wash.

## Files

- `plugins/primitives/plugins/data-view/core/internal/placement.ts`: slot, rank, recipe rules.
- `plugins/primitives/plugins/data-view/web/components/card-meta.tsx`: the `CardCaption` /
  `CardBody` split, the excerpt, and no icon on chip tokens.
- `plugins/primitives/plugins/data-view/plugins/gallery/web/components/{data-card,gallery-view}.tsx`
  and `web/internal/options.ts`: the poster shape.
- `plugins/ui/plugins/tokens/plugins/data-view/`: `cardExcerptLines`, `coverScrim`,
  `cardOnCoverInk`, `cardOnCoverSubtleInk` and `cardExcerptRule`. Defaults are chosen so
  nothing else changes.
- Docs: the gallery `CLAUDE.md` (the poster shape and its height rule), and the slot table in
  the data-view `CLAUDE.md`.
- `plugins/apps/plugins/places/plugins/places-map/web/{components/places-panel.tsx,internal/fields.tsx}`
  and `config/apps/places/places-map/places.panel.jsonc`.

## Verification

- `./equin test plugins/primitives/plugins/data-view`, with new tests:
  - placement: prose goes to `excerpt` where the view declares it and to `line2` where it
    does not;
  - a poster card renders caption, excerpt and tokens; no excerpt when the row's note is empty;
    a chip token has no icon;
  - `paged-conformance` with `card: "poster"`.
- `./equin check` (including `migrations-in-sync` and the docs-in-sync checks).
- `./equin build`. Then open `/places` with the side panel set to Gallery (browser tools) and
  compare it with the prototype (`compare-diff.ts --name proto-1792633470-xjmmji`, a structural
  comparison: the data differs). Look at:
  - the caption on the photo;
  - notes visible and clamped;
  - tag chips without the icon;
  - hover linked with the pins;
  - a place without a photo.
- Regression screenshots of the other galleries (prototypes, deploy sites, events, themes), so
  that the audit in step 1 holds.
