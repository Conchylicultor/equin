import type { PlaceFamily } from "@plugins/page/plugins/place/core";
import { GOOGLE_HEADING_FAMILY } from "../../shared/google-headings";
import { GOOGLE_TABLE_A, GOOGLE_TABLE_B } from "../../shared/table-a";

export interface GoogleFamilyResult {
  /** The place's family, or `undefined` when none of its types has a heading. */
  family: PlaceFamily | undefined;
  /**
   * The `primaryType`, when it is in neither of the copied tables: Google added
   * a type since `table-a.ts` was generated, and the copy needs regenerating.
   */
  unknownPrimary: string | undefined;
}

/**
 * Types whose Table A heading paints them unlike the Google Maps app. Google
 * files parks and gardens under "Entertainment and Recreation", beside tourist
 * attractions, zoos and night clubs — but the app paints them green, with
 * nature. The only overrides: everything else follows Google's heading. A key
 * that is not a Table A type fails the test.
 */
export const GOOGLE_FAMILY_OVERRIDES: Readonly<Record<string, PlaceFamily>> = {
  park: "nature",
  city_park: "nature",
  national_park: "nature",
  state_park: "nature",
  dog_park: "nature",
  garden: "nature",
  botanical_garden: "nature",
  hiking_area: "nature",
  picnic_ground: "nature",
  barbecue_area: "nature",
  wildlife_park: "nature",
  wildlife_refuge: "nature",
};

function familyOf(type: string): PlaceFamily | undefined {
  if (Object.hasOwn(GOOGLE_FAMILY_OVERRIDES, type)) {
    return GOOGLE_FAMILY_OVERRIDES[type];
  }
  return Object.hasOwn(GOOGLE_TABLE_A, type)
    ? GOOGLE_HEADING_FAMILY[GOOGLE_TABLE_A[type]!]
    : undefined;
}

/**
 * Pure: the family of a Google place — the Table A heading (or override) of its `primaryType`,
 * or else of the first of its `types` that has one (Google lists them most
 * specific first). A plain address (`street_address`, `route`, … — Table B)
 * has none.
 */
export function googleTypeToFamily(
  primaryType: string | undefined,
  types: readonly string[] | undefined,
): GoogleFamilyResult {
  const unknownPrimary =
    primaryType !== undefined &&
    !Object.hasOwn(GOOGLE_TABLE_A, primaryType) &&
    !GOOGLE_TABLE_B.has(primaryType)
      ? primaryType
      : undefined;
  const primary = primaryType === undefined ? undefined : familyOf(primaryType);
  if (primary !== undefined) return { family: primary, unknownPrimary };
  for (const type of types ?? []) {
    const family = familyOf(type);
    if (family !== undefined) return { family, unknownPrimary };
  }
  return { family: undefined, unknownPrimary };
}
