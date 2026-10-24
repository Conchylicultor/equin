# Place card — minimal redesign with type icons

## Context

The resolved `place` block card (`plugins/page/plugins/place/web/components/place-card.tsx`)
reads as cluttered: a `Card` with a small provider icon, the name, an address
caption, and a row of badges (category + "Open in Google Maps"), plus a dark
circular replace button. The user iterated on a prototype
(`proto-1790682751-y35e`, variant `icons=material`) and chose a minimal row:

- a 40px coloured circle holding a Material Symbols glyph for the **kind of place**
  (a T-shirt for clothing, a cup for a café, a tree for a park…), coloured by
  **family** (shopping, food, lodging, nature, culture, …);
- the name (semibold) over one muted line `category · address`;
- the whole row is the link to the provider's page — no "Open in …" badge, no
  provider name anywhere;
- copy-address + replace revealed on hover;
- refresh state inline in the muted line: a small spinner while refreshing,
  `Couldn't refresh · Retry` on failure.

Maps previews, photos, ratings and provider branding were all tried and
rejected.

## Design

### 1. A neutral `PlaceKind`, mapped by the provider

The icon is derived from the place's type, never hand-picked. Google returns
`primaryType` (`clothing_store`, `cafe`, `french_restaurant`, … — several
hundred values), but `PlaceSnapshot` is deliberately the **neutral vocabulary
every provider maps onto** (see `core/schemas.ts`). Storing Google's raw type
would leak one provider's taxonomy into the block's stored data and into every
consumer.

So the place plugin owns a **closed** kind set as plain data in `core/`
(closed list both runtimes need → `core`, not a slot):

```ts
// plugins/page/plugins/place/core/kinds.ts
export const PLACE_KINDS = {
  clothing:   { family: "shopping" },
  shop:       { family: "shopping" },
  grocery:    { family: "shopping" },
  cafe:       { family: "food" },
  bakery:     { family: "food" },
  restaurant: { family: "food" },
  bar:        { family: "food" },
  hotel:      { family: "lodging" },
  park:       { family: "nature" },
  museum:     { family: "culture" },
  attraction: { family: "culture" },
  worship:    { family: "culture" },
  transit:    { family: "transport" },
  parking:    { family: "transport" },
  health:     { family: "services" },
  fitness:    { family: "services" },
  school:     { family: "services" },
  address:    { family: "none" },   // a plain street address / locality
} as const;
export type PlaceKind = keyof typeof PLACE_KINDS;
export const PlaceKindSchema = z.enum(Object.keys(PLACE_KINDS) as [PlaceKind, ...PlaceKind[]]);
```

and the family → colour map (families are the avatar palette's colour names,
so the circle uses the theme's categorical tokens, light/dark aware):

```ts
export const PLACE_FAMILY_COLOR = {
  shopping: "violet", food: "orange", lodging: "sky", nature: "emerald",
  culture: "rose", transport: "indigo", services: "teal", none: "slate",
} as const satisfies Record<PlaceFamily, AvatarColorName>;
```

(`AVATAR_COLOR_NAMES` from `plugins/primitives/plugins/avatar/core`.)

- `PlaceSnapshotSchema` and `PlaceDataSchema` gain `kind: PlaceKindSchema.optional()`.
  Absent = unknown → the `none` family + a generic pin. No migration: both
  schemas are all-optional for display fields, old blocks parse unchanged.
- `placeDataFromSnapshot` (`core/staleness.ts`) copies `kind` (it replaces the
  payload wholesale, so forgetting it drops the field — covered by a test).
- Markdown round trip (`core/place-block.ts`): add `kind` to both `attrs()` and
  `parseAttrs()` (parse through `PlaceKindSchema.safeParse`; an unknown value
  reads as absent, not an error, since hand-written markdown can say anything).

### 2. Google maps its types onto kinds (server)

- `plugins/integrations/plugins/google-maps/plugins/places-api`:
  - `server/internal/field-mask.ts`: add `primaryType` and `types` to the
    details mask. Both are in the same SKU tier as the already-requested
    `displayName` / `primaryTypeDisplayName` — re-check the current SKU table
    when implementing (the file's comment warns Google re-cuts pricing).
  - `server/internal/details.ts` + `core/internal/types.ts`: surface
    `primaryType?: string` and `types?: string[]` on its (Google-shaped) result.
- `plugins/page/plugins/place/plugins/google/server/internal/provider.ts`
  (the "seam on purpose"): a `googleTypeToKind(primaryType, types)` table —
  exact `primaryType` match first (`clothing_store → clothing`,
  `cafe|coffee_shop → cafe`, `bakery → bakery`, `*_restaurant|restaurant → restaurant`,
  `bar|pub|wine_bar → bar`, `lodging|hotel → hotel`, `park|garden → park`,
  `museum|art_gallery → museum`, `street_address|route|premise|locality → address`, …),
  then the first match among `types`, else `undefined`. Pure function in the
  google sub-plugin's `server/internal/`, with a colocated `*.test.ts`.

Existing places pick up `kind` when their snapshot next refreshes (30-day TTL,
or immediately for snapshots without `fetchedAt`). Until then they render the
generic pin — a real, honest state, not a bug.

### 3. The glyph table (web)

`plugins/page/plugins/place/web/internal/kind-glyphs.ts`:

```ts
export const PLACE_KIND_GLYPH = {
  clothing: symbol("apparel"),   shop: symbol("storefront"),  grocery: symbol("shopping-bag"),
  cafe: symbol("local-cafe"),    bakery: symbol("bakery-dining"), restaurant: symbol("restaurant"),
  bar: symbol("local-bar"),      hotel: symbol("hotel"),      park: symbol("park"),
  museum: symbol("museum"),      attraction: symbol("attractions"), worship: symbol("church"),
  transit: symbol("train"),      parking: symbol("local-parking"),
  health: symbol("local-hospital"), fitness: symbol("fitness-center"), school: symbol("school"),
  address: symbol("location-on"),
} satisfies Record<PlaceKind, SymbolRef>;
```

Every glyph is a literal `symbol("…")` call so the sprite manifest scan
(`icons:manifest-in-sync`, lint `icons/literal-icon-name`) sees it; the
`satisfies Record<PlaceKind, …>` makes a new kind without a glyph a tsc error.
All names above are verified present in `symbol-names.generated.ts`.

### 4. The card (web)

Rewrite `place-card.tsx` as the row:

- **Leading circle**: `<Avatar shape="circle" symbol={glyph} color={familyColor} …/>`
  from `@plugins/primitives/plugins/avatar/web`, in its flat (solid fill,
  `categorical-foreground` glyph) presentation at 40px. If Avatar has no 40px
  size / flat circle mode, add that to Avatar rather than hand-rolling the
  circle here.
- **Text**: name as `Text variant="label"` (truncating leaf), then one muted
  caption line: `[state] category · address`, single line, truncates.
- **Link**: the whole row links to `data.mapsUrl` (new tab). The row actions
  must not be nested inside the `<a>` — render the anchor as the row's
  stretched hit-area and the actions as a sibling layer above it.
- **Actions**: `RowActions` (`plugins/primitives/plugins/row-actions/web`,
  `rowActionsAnchor` on the row) holding a copy-address button
  (`useCopyToClipboard` from `primitives/copy-to-clipboard`, content-copy →
  check) and the replace `IconButton`. Replaces the hand-rolled
  `hoverRevealGroup` + black circle.
- **Hover**: a subtle row background (the row surface token), no card border,
  no shadow.
- The provider contribution is no longer read for the icon or label; the card
  takes only `data` + state. (`provider.icon`/`label` stay in the slot for the
  search box.)
- Update `gutterFirstLineCenter` in `core/place-block.ts` to the new geometry
  (centre of the 40px circle / first text line, no card padding).

Follow the `css` skill: compose `Line`/`Fill`/`Stack`/`Text`, no ad-hoc flex.

### 5. Refresh state: `refreshing` + `retry`

`web/internal/use-place-resolve.ts` today returns only `{ error }`. Extend to
`{ error, refreshing, retry }`:

- `refreshing` — true from request start until it settles (set in the effect,
  cleared in `finally`).
- `retry()` — clears `startedRef` and bumps an attempt counter in the effect's
  deps, so the same place resolves again.

`place-block.tsx` passes these to the card, which renders them inline in the
caption line: a small spinner while `refreshing`, and
`Couldn't refresh · Retry` (destructive tone, Retry a link-button calling
`retry`) when `error` is set. The full error text goes in the Retry tooltip
rather than the line.

## Files

- `plugins/page/plugins/place/core/{kinds.ts (new), schemas.ts, staleness.ts, place-block.ts, index.ts}`
- `plugins/page/plugins/place/web/{components/place-card.tsx, components/place-block.tsx, internal/use-place-resolve.ts, internal/kind-glyphs.ts (new)}`
- `plugins/page/plugins/place/plugins/google/server/internal/{provider.ts, type-to-kind.ts (new) + test}`
- `plugins/integrations/plugins/google-maps/plugins/places-api/{server/internal/field-mask.ts, server/internal/details.ts, core/internal/types.ts}`
- `plugins/page/plugins/place/CLAUDE.md` — document `kind` and the mapping seam.
- Possibly `plugins/primitives/plugins/avatar/web` — only if a 40px flat circle is missing.

## Verification

- `./equin test plugins/page/plugins/place` — `staleness.test.ts` extended
  (kind survives `placeDataFromSnapshot`), new `type-to-kind.test.ts`, a
  markdown round-trip case for `kind`.
- `./equin build` (regenerates the icon manifest; `icons:manifest-in-sync`,
  type-check, boundary checks pass).
- In the deployed worktree: insert a `/place` block, pick a clothing store, a
  café, a park and a plain address; screenshot with
  `e2e-harness/e2e/screenshot.ts --path <page>` in light and dark, and compare
  against the prototype (`compare-diff.ts --name proto-1790682751-y35e --options icons=material`
  if a `mocks` tag is added). Hover shows copy/replace; copy puts the address
  on the clipboard; clicking the row opens Maps.
- Force a failed refresh (e.g. provider not set up) → `Couldn't refresh · Retry`
  inline; Retry re-issues the resolve (spinner shows while in flight).
