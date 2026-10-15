# Places map: every place visible (Google-style spots) — no more counter clusters

Mockup: `proto-1791725279-9yramg` with `crowd=google`, `size=small`, `far-count=label`.

## Context

At city zoom the Places map collapses neighbours into round "2 ✓1" counter discs
(`SavedPlaceCluster`, default 48px radius). To learn what the map holds the user
has to zoom into each disc. The user iterated the prototype and settled on the
Google Maps behaviour:

- **Never group.** Every place is always drawn.
- **Street zoom (≥ 13):** the drop pin, as today but **small** (0.8×).
- **Far out (< 13):** every place is a small **round badge centred on its spot**
  (same fill / icon / pale-vs-solid as the drop). Badges overlap; the
  better-ranked draws on top.
- **Count, far out only:** nearby badges (≤ 34 screen px) form a *spot*; its
  best-ranked badge (the *lead*) carries the spot size as halo map text **beside
  it** (no chip). Hovering any pin of a spot hides *that spot's* count only.
- **Names on hover only** (and on the open place) — already true in the app.

## Design

### map/core — rank + spots (pure)

- `MapPin.rank?: number` (`map/core/overlays.ts`): higher = more important —
  draws above lower-ranked overlapping pins and leads its spot. Absent = 0.
- New `map/core/spots.ts`: `groupSpots(points: {id, x, y, rank}[], radiusPx)
  → { lead: string; members: string[] }[]`. Greedy: seeds in (rank desc, id)
  order, each seed takes every unassigned point within `radiusPx`. Reuse the
  grid-cell neighbourhood from `cluster.ts` (extract the shared bucket helper
  rather than duplicating). Deterministic, unit-tested beside `cluster.test.ts`.

### map/web — the renderer contract

`MapRendererProps.cluster?: {radiusPx}` becomes a closed union, so "cluster"
and "spots" cannot both be asked for (rung 1):

```ts
type MapCrowd =
  | { kind: "cluster"; radiusPx: number }
  | { kind: "spots"; radiusPx: number; nearZoom: number };
crowd?: MapCrowd;   // absent = every pin drawn, no grouping
```

`MapPinProps` gains what a pin needs to draw itself in spots mode:

- `scale: "near" | "far"` — `far` below `nearZoom` (always `near` outside spots
  mode). The renderer anchors a `far` pin at its **centre**, a `near` one at its
  tip, so the pin never guesses its own anchor.
- `spot?: { count: number; hushed: boolean }` — only on a spot lead with
  `count > 1`, `far` only. `hushed` while any member of the spot is hovered.

`DefaultPin` handles `far` (its dot is already round → centre anchor) and
draws `spot.count` with `MapLabel` beside it, so a pin type with no
contribution still works in spots mode.

### map/plugins/google — `SpotPins`

New `components/spot-pins.tsx` beside `clustered-pins.tsx`, used when
`crowd.kind === "spots"`:

- Projects pins to world pixels with the existing `useProjectedZoom` (re-runs
  on zoom only; a pan never regroups) and calls `groupSpots` when far.
- Every pin is an `OverlayPin`; `anchor` from `scale`; `zIndex` from rank order
  (active on top, then rank, then id) — also replace the flat `1/2` z-index of
  the unclustered and clustered paths with the same rank order.
- Hover: `OverlayPin` gains `onHoverChange(boolean)` (pointerenter/leave on its
  container); `SpotPins` keeps the hovered pin's spot lead in state and passes
  `hushed` to that lead only.
- The active pin is always its own spot lead (never hidden behind a count).

### data-view map view

`MapViewOptions` (`data-view/plugins/map/core/internal/types.ts`):

- `cluster?: false | {radiusPx?}` → `crowd?: false | {kind:"cluster", radiusPx?}
  | {kind:"spots", radiusPx?, nearZoom?}`; default stays cluster (other consumers
  unchanged). Defaults `SPOTS_RADIUS_PX = 34`, `SPOTS_NEAR_ZOOM = 13` live in
  `map/core` next to `DEFAULT_CLUSTER_RADIUS_PX`.
- `rank?: (row) => number`, stamped by `rowsToPins` onto `MapPin.rank`.

### places-map

- `places-screen.tsx` view options: `crowd: { kind: "spots" }`,
  `rank: (p) => placeVisual(p, tags).want ? 1 : 0` (Want to go beats the rest;
  the open place is ranked by the renderer).
- **Small pins:** `DROP_HEAD_PX` 30 → 24 and derive the pin box, tip (√2·h/2 +
  h/2) and ground-shadow geometry in `saved-place-pin.tsx` from it instead of
  the literal `h-9 w-[30px]` / 8/33/14/6.
- `PlaceDropHead` gains `shape: "drop" | "disc"` (disc = no rotated corner);
  `SavedPlacePin` draws `scale="far"` as a ~19px disc (0.78 × head), name beside
  it on hover, and `spot.count` as a `MapLabel` beside it, faded while `hushed`
  or while this pin itself is hovered.
- Delete `SavedPlaceCluster`, its `GeoMap.Cluster` contribution and the now
  unused `clusterRing` / `clusterSizePx` / `BEEN_INK` in `pin-paint.ts`.
- Update the "Pins" section of `places-map/CLAUDE.md` and the map /
  data-view-map CLAUDE.md docs for `crowd`, `rank`, `scale`, `spot`.

## Critical files

- `plugins/map/core/{overlays.ts,cluster.ts,spots.ts(new),index.ts}`
- `plugins/map/web/{slots.ts,components/default-pin.tsx,components/map-view.tsx}`
- `plugins/map/plugins/google/web/components/{google-map-impl.tsx,clustered-pins.tsx,overlay-pin.tsx,spot-pins.tsx(new)}`
- `plugins/primitives/plugins/data-view/plugins/map/{core/internal/types.ts,web/internal/row-pins.ts,web/components/map-data-view.tsx}`
- `plugins/apps/plugins/places/plugins/places-map/web/{components/places-screen.tsx,saved-place-pin.tsx,place-drop.tsx,saved-place-cluster.tsx(delete),internal/pin-paint.ts,index.ts}`

## Verification

- `./singularity test plugins/map` — new `spots.test.ts`: lead = highest rank,
  radius boundary, determinism under input order, active-free.
- `./singularity build`, then `screenshot.ts --path /places` at street zoom
  (all pins, small, no labels) and after the fit button (round badges, side
  counts); hover a member pin and confirm only its spot's count fades.
- `./singularity check` (boundaries, docs in sync, lint).
