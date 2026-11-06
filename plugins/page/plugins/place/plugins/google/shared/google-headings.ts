import type { PlaceFamily } from "@plugins/page/plugins/place/core";

/**
 * Google's Table A headings, verbatim — the categories it files every place
 * type under (https://developers.google.com/maps/documentation/places/web-service/place-types).
 * `scripts/fetch-table-a.ts` refuses a heading missing here.
 */
export const GOOGLE_HEADINGS = [
  "Automotive",
  "Business",
  "Culture",
  "Education",
  "Entertainment and Recreation",
  "Facilities",
  "Finance",
  "Food and Drink",
  "Geographical Areas",
  "Government",
  "Health and Wellness",
  "Housing",
  "Lodging",
  "Natural Features",
  "Places of Worship",
  "Services",
  "Shopping",
  "Sports",
  "Transportation",
] as const;

export type GoogleHeading = (typeof GOOGLE_HEADINGS)[number];

/** Google's heading → the block's neutral family. One row each; tsc catches a missing one. */
export const GOOGLE_HEADING_FAMILY = {
  Automotive: "automotive",
  Business: "business",
  Culture: "culture",
  Education: "education",
  "Entertainment and Recreation": "entertainment",
  Facilities: "facilities",
  Finance: "finance",
  "Food and Drink": "food",
  "Geographical Areas": "geographic",
  Government: "government",
  "Health and Wellness": "health",
  Housing: "housing",
  Lodging: "lodging",
  "Natural Features": "nature",
  "Places of Worship": "worship",
  Services: "services",
  Shopping: "shopping",
  Sports: "sports",
  Transportation: "transport",
} as const satisfies Record<GoogleHeading, PlaceFamily>;
