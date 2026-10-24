# Place card colours from Google's Table A

## Context

A place block's circle is coloured by a family table invented in
`plugins/page/plugins/place/core/kinds.ts` (`PLACE_FAMILY_COLOR`): shops are
violet, culture is rose, and so on. Nothing ties it to Google, so a page of
shops reads purple while Google Maps shows them blue.

Decisions from the discussion:

1. **Category source = Google's Table A**
   (<https://developers.google.com/maps/documentation/places/web-service/place-types>):
   ~800 types under 19 headings. `primaryType` is always a Table A type. No API
   returns or lists the headings, so we vendor the type → heading table.
2. **Not** `iconBackgroundColor` / `iconMaskBaseUri`: those are Maps Platform
   pinlet colours (8 coarse families, lodging under Services, monuments
   slate), not the Maps app.
3. **Colours mimic the Maps app by eye.** Google publishes no app palette. The
   app uses ~7–9 visible colours (post-2024 redesign: museums purple, hotels
   pink, shops blue, food orange, parks green). The 19 headings group onto
   those, painted with existing avatar palette slots — so theming and dark mode
   keep working and the avatar primitive is untouched.
4. **The vendored table is checked, not scraped on a schedule.** An unknown
   `primaryType` at runtime is reported loudly (a report), never silently
   generic.
5. **Stored data stays provider-neutral**: the 19 headings get our own names in
   `core`; Google's type strings never reach block data.

End state: Google's own taxonomy decides a place's family; one table in `core`
decides the colour each family is painted; glyphs stay per kind.

## Design

### core: family = Table A heading (neutral names)

`plugins/page/plugins/place/core/kinds.ts`

- Replace `PlaceFamily` with the 19 Table A headings, neutral spelling:
  `automotive, business, culture, education, entertainment, facilities,
  finance, food, geographic, government, health, housing, lodging, nature,
  worship, services, shopping, sports, transport`. Export
  `PLACE_FAMILIES` + `PlaceFamilySchema`.
- Drop `family` from `PLACE_KINDS` rows (kind is now glyph-only); the
  `satisfies Record<PlaceKind, SymbolRef>` glyph table is unchanged.
- `PLACE_FAMILY_COLOR` becomes `Record<PlaceFamily, AvatarColor>` grouping the
  19 onto the app's ~8 colours (first proposal, to be tuned by eye against
  app screenshots):

  | App colour | Families | Avatar slot |
  |---|---|---|
  | blue | shopping | `sky` |
  | orange | food | `orange` |
  | pink | lodging | `pink` |
  | purple | culture, entertainment | `violet` |
  | lavender | finance, automotive | `indigo` |
  | green | nature, sports | `emerald` |
  | red | health | `rose` |
  | transit blue | transport | `teal` |
  | grey | business, education, facilities, geographic, government, housing, services, worship | `slate` |

- `placeKindColor(kind)` → `placeFamilyColor(family: PlaceFamily | undefined)`
  (`undefined` → `slate`).

`core/schemas.ts`: add `family: PlaceFamilySchema.optional()` to
`PlaceSnapshotSchema` and `PlaceDataSchema`, documented as "the provider's
category, mapped onto the neutral families; absent = unknown → neutral circle".

`core/place-block.ts`: carry `family` as a markdown attr, parsed like
`kindAttr` (an unknown value from a newer build reads as absent).

### google provider: vendored Table A

`plugins/page/plugins/place/plugins/google/`

- `server/internal/table-a.ts` — `GOOGLE_TABLE_A: Record<string,
  GoogleHeading>` (~800 rows), header comment naming the source URL and the
  date fetched. `GoogleHeading` is the closed union of Google's 19 headings
  verbatim; `GOOGLE_HEADING_FAMILY satisfies Record<GoogleHeading,
  PlaceFamily>` maps them (tsc catches a missing heading).
- `scripts/fetch-table-a.ts` — one-shot generator: fetches the docs page,
  parses the per-heading tables, writes `table-a.ts`. Run by hand
  (`./equin run …`) when refreshing; not on a schedule.
- `server/internal/type-to-family.ts` — `googleTypeToFamily(primaryType,
  types)`: `primaryType`'s heading if present in the table, else the first of
  `types` that is, else `undefined`. Returns `{ family, unknownPrimary }` so the
  caller can report.
- `provider.ts` `resolve`: set `family`; when `primaryType` is present but not
  in the table, `recordReport` a new warning kind
  (`place-google-unknown-type`, fingerprint = the type, via `ReportKind` —
  pattern: `plugins/debug/plugins/stall-monitor/server/internal/stall-kind.ts`)
  and render neutral. Not a throw: a new Google type must not break resolve.
- `type-to-kind.ts` stays (glyphs only); its comments drop any colour mention.

### web

`web/components/place-card.tsx:62`: `color={placeFamilyColor(data.family)}`.

### Existing blocks

Blocks saved before this have no `family` → neutral circle until their next
refresh (30-day TTL, or the card's Refresh). No migration: the field is
optional and additive; `kind` is unchanged.

### Docs

Update `plugins/page/plugins/place/CLAUDE.md` (adding a kind no longer picks a
colour; family comes from the provider) and the Google sub-plugin's CLAUDE.md
(table-a, refresh script, unknown-type report).

## Out of scope (follow-up task)

`Avatar`'s `color?: string | null` silently falls back to the hashed
auto-colour for an unknown name (`plugins/primitives/plugins/avatar/web/internal/colors.ts`,
`avatarColorPick`) — an absorbed failure. Narrowing it to `AvatarColor` touches
~23 callers and stored user colours; file separately.

## Verification

- `./equin test plugins/page/plugins/place` — new tests:
  - `table-a.test.ts`: every row's heading is a `GoogleHeading`; table size
    sanity (> 700); a few spot rows (`clothing_store → Shopping`,
    `museum → Culture`, `monument → Culture`, `hotel → Lodging`).
  - `type-to-family.test.ts`: primary wins; falls back through `types`;
    unknown primary → `unknownPrimary` set; pure address (`street_address`
    only) → `undefined`.
  - `kinds` test: every family has a colour (tsc already) and the grouping
    table above.
- `./equin build`, then open the page from the screenshot, press Refresh
  on each card, and screenshot
  (`plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts
  --path /pages/page/<id>`): shops blue, a museum purple, a hotel pink.
- Compare side by side with Google Maps for the same places; adjust the slot
  choice in `PLACE_FAMILY_COLOR` if a family reads off.
