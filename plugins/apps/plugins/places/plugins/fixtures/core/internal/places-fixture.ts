/**
 * A tag path, root first (`["Food", "Bakery"]`): a tag of the starter tree
 * (`Want to go`, `Food`), or one the fixture's `tags` adds.
 */
export type PlaceTagPath = readonly [string, ...string[]];

/** A tag the fixture adds to the tree (its missing ancestors too), with its look. */
export interface PlaceTagFixture {
  path: PlaceTagPath;
  /** `#rrggbb`; absent inherits the nearest ancestor's colour. */
  color?: string;
  /** A Material Symbols name (`bakery-dining`). */
  icon?: string;
}

/** Where a fixture place comes from: a Google place as Google described it, or a custom pin. */
export type PlaceFixtureSource =
  | {
      kind: "google";
      googlePlaceId: string;
      name: string;
      address: string;
      lat: number;
      lng: number;
      primaryType: string;
      types: readonly string[];
    }
  | { kind: "custom"; name: string; address: string; lat: number; lng: number };

/** One saved place. */
export interface PlaceFixture {
  /** The caller's place id (`place-<stamp>-<suffix>`). */
  id: string;
  place: PlaceFixtureSource;
  tags: readonly PlaceTagPath[];
  /** Its map icon, a Material Symbols name — given, so no model picks one. */
  icon: string;
  note?: string;
  /** When it was saved, in days before the write. */
  savedDaysAgo: number;
}

/**
 * Some saved places and the tags they need, in the app's own terms. Written
 * by `writePlacesFixture` (server) on top of the starter tag tree a fresh
 * install has.
 */
export interface PlacesFixture {
  tags: readonly PlaceTagFixture[];
  places: readonly PlaceFixture[];
}
