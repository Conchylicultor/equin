import type { PlaceKind } from "@plugins/page/plugins/place/core";

/**
 * Google place types (Places API (New), Table A/B) → the place block's neutral
 * kinds. Only the types worth their own icon are listed; everything else falls
 * through to the suffix rules below, then to "no kind" (a generic pin).
 */
const EXACT: Record<string, PlaceKind> = {
  // shopping
  clothing_store: "clothing",
  shoe_store: "clothing",
  jewelry_store: "clothing",
  supermarket: "grocery",
  grocery_store: "grocery",
  convenience_store: "grocery",
  market: "grocery",
  shopping_mall: "shop",
  department_store: "shop",
  store: "shop",
  // food & drink
  cafe: "cafe",
  coffee_shop: "cafe",
  tea_house: "cafe",
  bakery: "bakery",
  pastry_shop: "bakery",
  restaurant: "restaurant",
  meal_takeaway: "restaurant",
  meal_delivery: "restaurant",
  food_court: "restaurant",
  bar: "bar",
  pub: "bar",
  wine_bar: "bar",
  night_club: "bar",
  // lodging
  lodging: "hotel",
  hotel: "hotel",
  motel: "hotel",
  hostel: "hotel",
  inn: "hotel",
  bed_and_breakfast: "hotel",
  guest_house: "hotel",
  resort_hotel: "hotel",
  campground: "hotel",
  // nature
  park: "park",
  national_park: "park",
  state_park: "park",
  city_park: "park",
  garden: "park",
  botanical_garden: "park",
  dog_park: "park",
  hiking_area: "park",
  beach: "park",
  // culture
  museum: "museum",
  art_gallery: "museum",
  history_museum: "museum",
  art_museum: "museum",
  tourist_attraction: "attraction",
  historical_landmark: "attraction",
  monument: "attraction",
  amusement_park: "attraction",
  aquarium: "attraction",
  zoo: "attraction",
  performing_arts_theater: "attraction",
  movie_theater: "attraction",
  stadium: "attraction",
  place_of_worship: "worship",
  church: "worship",
  mosque: "worship",
  synagogue: "worship",
  hindu_temple: "worship",
  // transport
  train_station: "transit",
  subway_station: "transit",
  light_rail_station: "transit",
  bus_station: "transit",
  transit_station: "transit",
  airport: "transit",
  ferry_terminal: "transit",
  parking: "parking",
  parking_lot: "parking",
  parking_garage: "parking",
  // services
  hospital: "health",
  pharmacy: "health",
  drugstore: "health",
  doctor: "health",
  dentist: "health",
  gym: "fitness",
  fitness_center: "fitness",
  yoga_studio: "fitness",
  swimming_pool: "fitness",
  school: "school",
  primary_school: "school",
  secondary_school: "school",
  university: "school",
  library: "school",
  // somewhere, not a venue
  street_address: "address",
  premise: "address",
  subpremise: "address",
  route: "address",
  intersection: "address",
  plus_code: "address",
  postal_code: "address",
  neighborhood: "address",
  sublocality: "address",
  locality: "address",
  administrative_area_level_1: "address",
  administrative_area_level_2: "address",
  country: "address",
  geocode: "address",
};

/** A type Google coins faster than the table above grows (`thai_restaurant`, `toy_store`, …). */
function bySuffix(type: string): PlaceKind | undefined {
  if (type.endsWith("_restaurant")) return "restaurant";
  if (type.endsWith("_store") || type.endsWith("_shop")) return "shop";
  return undefined;
}

function kindOf(type: string): PlaceKind | undefined {
  return Object.hasOwn(EXACT, type) ? EXACT[type] : bySuffix(type);
}

/**
 * Pure: the kind of a Google place. `primaryType` wins whenever it maps;
 * otherwise the first of `types` (Google lists them most specific first) that
 * does. `undefined` = no kind — the card draws a generic pin.
 */
export function googleTypeToKind(
  primaryType: string | undefined,
  types: readonly string[] | undefined,
): PlaceKind | undefined {
  const primary = primaryType === undefined ? undefined : kindOf(primaryType);
  if (primary !== undefined) return primary;
  for (const type of types ?? []) {
    const kind = kindOf(type);
    if (kind !== undefined) return kind;
  }
  return undefined;
}
