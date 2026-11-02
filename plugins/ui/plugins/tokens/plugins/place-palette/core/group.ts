import { defineTokenGroup } from "@plugins/ui/plugins/theme-engine/core";

// The Google Maps app's pin fills, sampled from screenshots (Google publishes
// none). Families Maps paints alike share a value.
const SHOPS = "#0497FF";
const FOOD = "#FF8127";
const HOTEL = "#F848C7";
const CULTURE = "#B56AFF";
const BANK = "#697BD4";
const PARK = "#178038";
const HEALTH = "#F74A56";
const TRANSIT = "#4A6276";
const GREY = "#78909C";
// A page's places laid over the Places map: a deep teal no family wears.
const OVERLAY = "#0f766e";

function token(label: string, value: string) {
  return { default: value, darkDefault: value, label };
}

/**
 * The place card's palette: one colour per family, painted as `--place-<family>`.
 * Its own token group rather than categorical slots, because these colours
 * MEAN something — they are the ones Google Maps paints the same places with —
 * so a place reads the same here as on the map, while every other avatar keeps
 * the categorical palette. A theme may still restyle them, like any group.
 */
export const placePaletteGroup = defineTokenGroup("place", {
  "place-shopping": token("Shopping", SHOPS),
  "place-food": token("Food and drink", FOOD),
  "place-lodging": token("Lodging", HOTEL),
  "place-culture": token("Culture", CULTURE),
  "place-entertainment": token("Entertainment and recreation", CULTURE),
  "place-finance": token("Finance", BANK),
  "place-automotive": token("Automotive", BANK),
  "place-nature": token("Nature", PARK),
  "place-sports": token("Sports", PARK),
  "place-health": token("Health and wellness", HEALTH),
  "place-transport": token("Transportation", TRANSIT),
  "place-business": token("Business", GREY),
  "place-education": token("Education", GREY),
  "place-facilities": token("Facilities", GREY),
  "place-geographic": token("Geographical areas", GREY),
  "place-government": token("Government", GREY),
  "place-housing": token("Housing", GREY),
  "place-services": token("Services", GREY),
  "place-worship": token("Places of worship", GREY),
  /** A place with no family: an address, or a type the provider has no heading for. */
  "place-none": token("No family", GREY),
  /**
   * Not a family: the accent of a page's places laid over the Places map
   * (their numbers, the dashed ring of one not saved yet, the overlay
   * panel's chip and Save all) — one colour no family wears, so the page's
   * places read apart from yours.
   */
  "place-overlay": token("Page overlay", OVERLAY),
});

/** One place colour token: `place-<family>`, or `place-none`. */
export type PlacePaletteToken = keyof typeof placePaletteGroup.schema;

/** Pure: the CSS colour a token paints, for a style or an `Avatar` `fill`. */
export function placeTokenFill(token: PlacePaletteToken): string {
  return `var(--${token})`;
}
