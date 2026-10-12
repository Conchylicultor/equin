# Places — vision

A Google-Maps-like app to **save my places and explore them**. Prototype:
`proto-1791725279-9yramg` ("Places map"). Implementation plan:
[`2026-10-12-global-places-app-plan.md`](2026-10-12-global-places-app-plan.md).

## Why

Saved places today live in Google Maps lists or Mapstr: flat lists, weak
filters, no way to ask "French restaurants in Paris I haven't tried, that Alex
recommended". What Mapstr gets right is its **tag system**: one glance at the map
tells you what each place is and how it relates to you. Places keeps that and
adds Singularity's strengths — records in a DataView (arbitrary queries, saved
views, map / gallery / list), and later agents.

## The jobs

| Job | Example |
|---|---|
| **Save** | Search a place, pick it → it is tagged automatically (category from Google types) and gets an icon. |
| **Recall** | "Where was that wine bar in Lyon?" → tag tree + query → map. |
| **Explore** | "What have I saved around here, what's still to do?" → map with clusters, todo/done at a glance. |
| **Curate** | Saved views: "Paris · to eat", "Date ideas". |
| Plan, share, agent capture (later) | Trips from a set of places; "save the ramen place Alex mentioned". |

## Principles (decided with the user)

1. **Tags are the core, and all tags are equal.** One nested tree
   (`Food & drinks › Restaurants › French`, `Trips › Japan 2027`, `Recommended by › Alex`).
   No category/label distinction: a category is just a tag. Any tag may carry a
   colour and an icon; a tag without a colour uses its nearest ancestor's.
2. **Todo / Done is a tag too** (two seeded tags under `Status`), shown on the pin
   as its *style*: done = solid drop, todo = the same drop washed pale.
3. **Automatic tags, never overwriting yours.** A tag may list Google place types
   (`french_restaurant`, `cafe`…); saving a place of that type sets the tag. A tag
   remembers it was set automatically (AUTO badge) — re-tagging never touches
   tags you set by hand.
4. **Every place gets an icon.** Haiku picks a Material Symbols icon for each
   place (unique to it, not just its kind: Rodin → palette). Material Symbols,
   not emoji: emoji (colour or mono) were unreadable at pin size.
5. **The map is a DataView view.** Places are records; Map, Gallery and List are
   view types over the same filtered rows, with saved views. The map view is
   generic — any DataView with a location field gets it (events, trips…).
6. **The tag sidebar owns the tag filter; the query is the single source of truth.**
   Clicking a tag cycles include → exclude → off, with an any/all switch. Each is
   a clause of the view's filter ("has *Restaurants* or anything nested under
   it"), so the advanced query builder (AND/OR groups, other fields) shows and
   composes the same query.
7. **Desktop first, map first.** The map is full screen; every piece of chrome
   floats on it as a card: tag sidebar (left), view tabs + filter pill (top),
   search + Add place (top right), place card (right), legend (bottom).
8. **Agents later**, but the model keeps room for them (capture, explore, taste
   signals from tags).

## The pin

The proto-1791018718-iear **drop** (teardrop, white 2px outline, ground shadow):

- Fill = the place's coloured tags as conic slices (one colour → solid).
- The place's Material icon sits straight on the fill, white, ~18px, no disc
  behind it (soft shadow keeps it readable where slices meet).
- Todo: the same slices washed pale, icon in a darker shade of the main colour.
- Name label (halo text) beside the pin at street zoom, on hover and when selected.
- Nearby pins merge into a **cluster**: a disc ringed by the colour mix of the
  places inside, with the count (and `✓ n` done).

## Screens

- **Map** (main): the floating layout above. Selecting a pin opens the place
  card: icon, name, address, Todo/Done switch, tags with their path and AUTO
  badge, add/remove tag, note, Google Maps link.
- **Gallery / List**: the same rows and filter, other view types.
- **Manage tags**: the tree as an editable table — name, parent, colour (own or
  inherited), icon (Material picker), Google types, place count, add child, delete.
- **Add place**: Google search → pick → saved with its automatic tags.

## Building blocks it adds to Singularity (reusable)

- `location` field type (lat/lng + address).
- DataView **map view** (`data-view/plugins/map`).
- **Hierarchical options** on DataView fields + a "has X or anything nested
  under it" tags operator.
- **Floating toolbar arrangement** + host **aside** panel for DataView, so any
  canvas-like view (map, later boards) can float its chrome.
- **Pin clustering** in the `map` primitive.
