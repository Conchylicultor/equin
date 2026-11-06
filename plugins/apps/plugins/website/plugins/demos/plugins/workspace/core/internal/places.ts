import type {
  PlaceFixture,
  PlacesFixture,
} from "@plugins/apps/plugins/places/plugins/fixtures/core";

// Demo's Places map: a trip to Lisbon being planned (most still to go, a few
// places from a first visit already been to), on the starter tag tree a fresh
// install has plus Demo's own "Trips › Lisbon" tag and a Bakery under Food.
// The Google places are real (their ids, names, types and positions as Google
// gives them), written as saved — no Google call is made, and in the demo
// their details and photos say "not available". Icons are given: no model
// picks one. The format and its writer are Places' (`apps/places/fixtures`);
// which places the demo shows is the demo's.

/** A seeded place id: stamped and carrying `demo`, like every demo id. */
const placeId = (n: number) =>
  `place-1792900000-demo${String(n).padStart(2, "0")}`;

const LISBON = ["Trips", "Lisbon"] as const;
const WANT = ["Want to go"] as const;
const BEEN = ["Been"] as const;

/** A Google place in Lisbon, as Google describes it. */
function google(
  googlePlaceId: string,
  name: string,
  address: string,
  [lat, lng]: readonly [number, number],
  primaryType: string,
  types: readonly string[],
): PlaceFixture["place"] {
  return {
    kind: "google",
    googlePlaceId,
    name,
    address,
    lat,
    lng,
    primaryType,
    types: [primaryType, ...types],
  };
}

const PLACES: readonly PlaceFixture[] = [
  {
    id: placeId(1),
    place: google(
      "ChIJNTZ10A0zGQ0ROwhyCh2mkwg",
      "Museu Calouste Gulbenkian",
      "Av. de Berna 45A, 1067-001 Lisboa, Portugal",
      [38.7372, -9.1545],
      "museum",
      ["tourist_attraction", "point_of_interest"],
    ),
    tags: [WANT, LISBON, ["Museum", "Art"]],
    icon: "palette",
    note: "Friday morning, booked.",
    savedDaysAgo: 12,
  },
  {
    id: placeId(2),
    place: google(
      "ChIJkfTl003LHg0RxFtZGUxQE8s",
      "MAAT – Museum of Art, Architecture and Technology",
      "Av. Brasília, 1300-598 Lisboa, Portugal",
      [38.6957, -9.1932],
      "museum",
      ["tourist_attraction", "point_of_interest"],
    ),
    tags: [WANT, LISBON, ["Museum", "Art"]],
    icon: "museum",
    note: "Walk along the river from Belém.",
    savedDaysAgo: 12,
  },
  {
    id: placeId(3),
    place: google(
      "ChIJS5zCw0LLHg0RP1FSz63cAjA",
      "Torre de Belém",
      "Av. Brasília, 1400-038 Lisboa, Portugal",
      [38.6916, -9.216],
      "historical_landmark",
      ["tourist_attraction", "point_of_interest"],
    ),
    tags: [BEEN, LISBON, ["Attraction"]],
    icon: "fort",
    savedDaysAgo: 400,
  },
  {
    id: placeId(4),
    place: google(
      "ChIJW3H9LkXLHg0RZZZttMb27_8",
      "Pastéis de Belém",
      "R. de Belém 84-92, 1300-085 Lisboa, Portugal",
      [38.6975, -9.2033],
      "bakery",
      ["cafe", "food", "point_of_interest"],
    ),
    tags: [BEEN, LISBON, ["Food", "Bakery"]],
    icon: "bakery-dining",
    note: "Go early, the queue moves fast anyway.",
    savedDaysAgo: 400,
  },
  {
    id: placeId(5),
    place: google(
      "ChIJm8MOtHc0GQ0R1zPkmUFwwLQ",
      "Castelo de São Jorge",
      "R. de Santa Cruz do Castelo, 1100-129 Lisboa, Portugal",
      [38.7139, -9.1335],
      "historical_landmark",
      ["tourist_attraction", "point_of_interest"],
    ),
    tags: [WANT, LISBON, ["Attraction"]],
    icon: "castle",
    savedDaysAgo: 12,
  },
  {
    id: placeId(6),
    place: google(
      "ChIJV32DNI8zGQ0R9GqiWeuNH2E",
      "Miradouro da Senhora do Monte",
      "Largo Monte, 1170-107 Lisboa, Portugal",
      [38.7193, -9.1327],
      "observation_deck",
      ["tourist_attraction", "point_of_interest"],
    ),
    tags: [WANT, LISBON, ["Extérieur"]],
    icon: "landscape",
    note: "Sunset, take the 28 tram up.",
    savedDaysAgo: 12,
  },
  {
    id: placeId(7),
    place: google(
      "ChIJ-R6VlIUzGQ0RX8x1jtg9lh0",
      "Cervejaria Ramiro",
      "Av. Almirante Reis nº1 - H, 1150-007 Lisboa, Portugal",
      [38.7206, -9.1358],
      "seafood_restaurant",
      ["restaurant", "food", "point_of_interest"],
    ),
    tags: [WANT, LISBON, ["Food", "Restaurant"]],
    icon: "set-meal",
    note: "Saturday dinner. The garlic prawns.",
    savedDaysAgo: 12,
  },
  {
    id: placeId(8),
    place: google(
      "ChIJdWBeWYc0GQ0RktxySU7hjxM",
      "Time Out Market Lisboa",
      "Av. 24 de Julho 49, 1200-479 Lisboa, Portugal",
      [38.7071, -9.1458],
      "food_court",
      ["restaurant", "food", "point_of_interest"],
    ),
    tags: [WANT, LISBON, ["Food", "Restaurant"]],
    icon: "restaurant",
    savedDaysAgo: 12,
  },
  {
    id: placeId(9),
    place: google(
      "ChIJTRo64mU1GQ0RfEYk1nPW13c",
      "Park Bar",
      "Calçada do Combro 58, 1200-123 Lisboa, Portugal",
      [38.7108, -9.1477],
      "bar",
      ["point_of_interest"],
    ),
    tags: [WANT, LISBON, ["Food", "Bar"]],
    icon: "local-bar",
    note: "On top of a car park, ask for the lift.",
    savedDaysAgo: 12,
  },
  {
    id: placeId(10),
    place: google(
      "ChIJ5dveYa80GQ0RrEP1FKqq6zM",
      "LX Factory",
      "R. Rodrigues de Faria 103, 1300-501 Lisboa, Portugal",
      [38.7034, -9.1786],
      "shopping_mall",
      ["point_of_interest"],
    ),
    tags: [WANT, LISBON, ["Shop"]],
    icon: "storefront",
    note: "Ler Devagar bookshop.",
    savedDaysAgo: 12,
  },
  {
    id: placeId(11),
    place: google(
      "ChIJqzZCU2MzGQ0RkegDvwGR1ys",
      "Jardim da Estrela",
      "Praça da Estrela, 1200-667 Lisboa, Portugal",
      [38.7139, -9.1597],
      "park",
      ["tourist_attraction", "point_of_interest"],
    ),
    tags: [BEEN, LISBON, ["Extérieur"]],
    icon: "park",
    savedDaysAgo: 400,
  },
  {
    id: placeId(12),
    place: {
      kind: "custom",
      name: "Ana's flat",
      address: "Alfama",
      lat: 38.7118,
      lng: -9.129,
    },
    tags: [WANT, LISBON, ["Home"]],
    icon: "home",
    note: "Where we stay. Keys at the café downstairs.",
    savedDaysAgo: 20,
  },
  {
    id: placeId(13),
    place: {
      kind: "custom",
      name: "Fado night",
      address: "",
      lat: 38.711,
      lng: -9.131,
    },
    tags: [WANT, LISBON, ["Jeux/Shows/Events"]],
    icon: "music-note",
    note: "Ana's tip: the small place with no sign, after 10 pm.",
    savedDaysAgo: 5,
  },
  {
    id: placeId(14),
    place: {
      kind: "custom",
      name: "Tram 28, from Martim Moniz",
      address: "Martim Moniz",
      lat: 38.716,
      lng: -9.136,
    },
    tags: [WANT, LISBON, ["Attraction"]],
    icon: "tram",
    note: "Board at the first stop to get a seat.",
    savedDaysAgo: 5,
  },
  {
    id: placeId(15),
    place: {
      kind: "custom",
      name: "Steps by the river",
      address: "Ribeira das Naus",
      lat: 38.7065,
      lng: -9.1408,
    },
    tags: [BEEN, LISBON, ["Extérieur"]],
    icon: "wb-twilight",
    note: "Where we watched the sun go down last time.",
    savedDaysAgo: 400,
  },
];

export const DEMO_PLACES: PlacesFixture = {
  tags: [
    { path: ["Trips"], color: "#0ea5e9", icon: "flight" },
    { path: LISBON, icon: "location-city" },
    { path: ["Food", "Bakery"], icon: "bakery-dining" },
  ],
  places: PLACES,
};
