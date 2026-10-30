import type { SeedTagKey } from "@plugins/apps/plugins/places/plugins/places-core/server";

// The film's saved places: a trip to Lisbon, some been to, most still to go.
// Custom places (a name and a pin, no Google id), so drawing them calls no
// Places API; the icon is given, so no Haiku pick runs and every seed draws the
// same map.

export interface FilmPlace {
  name: string;
  address: string;
  lat: number;
  lng: number;
  tags: readonly SeedTagKey[];
  /** A Material Symbols name, checked at seed (`parseSavedSymbolName`). */
  icon: string;
  note: string;
  /** Days before the seed it was saved. */
  savedDaysAgo: number;
}

export const FILM_PLACES: readonly FilmPlace[] = [
  {
    name: "Museu Calouste Gulbenkian",
    address: "Av. de Berna 45A, 1067-001 Lisboa",
    lat: 38.7372,
    lng: -9.1546,
    tags: ["want", "museum", "art"],
    icon: "palette",
    note: "Friday morning, booked.",
    savedDaysAgo: 12,
  },
  {
    name: "MAAT",
    address: "Av. Brasília, 1300-598 Lisboa",
    lat: 38.6957,
    lng: -9.1946,
    tags: ["want", "museum", "art"],
    icon: "museum",
    note: "Walk along the river from Belém.",
    savedDaysAgo: 12,
  },
  {
    name: "Torre de Belém",
    address: "Av. Brasília, 1400-038 Lisboa",
    lat: 38.6916,
    lng: -9.216,
    tags: ["been", "attraction"],
    icon: "fort",
    note: "",
    savedDaysAgo: 400,
  },
  {
    name: "Pastéis de Belém",
    address: "R. de Belém 84-92, 1300-085 Lisboa",
    lat: 38.6975,
    lng: -9.2032,
    tags: ["been", "food", "snacks"],
    icon: "bakery-dining",
    note: "Go early, the queue moves fast anyway.",
    savedDaysAgo: 400,
  },
  {
    name: "Castelo de São Jorge",
    address: "R. de Santa Cruz do Castelo, 1100-129 Lisboa",
    lat: 38.7139,
    lng: -9.1335,
    tags: ["want", "attraction"],
    icon: "castle",
    note: "",
    savedDaysAgo: 11,
  },
  {
    name: "Miradouro da Senhora do Monte",
    address: "Largo Monte, 1170-253 Lisboa",
    lat: 38.7192,
    lng: -9.1328,
    tags: ["want", "outdoors"],
    icon: "landscape",
    note: "Sunset.",
    savedDaysAgo: 11,
  },
  {
    name: "Cervejaria Ramiro",
    address: "Av. Almirante Reis 1, 1150-007 Lisboa",
    lat: 38.7208,
    lng: -9.1356,
    tags: ["want", "food", "restaurant"],
    icon: "set-meal",
    note: "Seafood. Saturday dinner.",
    savedDaysAgo: 10,
  },
  {
    name: "Time Out Market",
    address: "Av. 24 de Julho 49, 1200-479 Lisboa",
    lat: 38.7069,
    lng: -9.1459,
    tags: ["want", "food"],
    icon: "restaurant",
    note: "",
    savedDaysAgo: 10,
  },
  {
    name: "Park Bar",
    address: "Calçada do Combro 58, 1200-123 Lisboa",
    lat: 38.711,
    lng: -9.147,
    tags: ["want", "bar"],
    icon: "local-bar",
    note: "Rooftop on a car park, view over the river.",
    savedDaysAgo: 9,
  },
  {
    name: "LX Factory",
    address: "R. Rodrigues de Faria 103, 1300-501 Lisboa",
    lat: 38.7036,
    lng: -9.1786,
    tags: ["want", "shop"],
    icon: "storefront",
    note: "Ler Devagar bookshop.",
    savedDaysAgo: 9,
  },
  {
    name: "Jardim da Estrela",
    address: "Praça da Estrela, 1200-667 Lisboa",
    lat: 38.7136,
    lng: -9.1597,
    tags: ["want", "outdoors"],
    icon: "park",
    note: "",
    savedDaysAgo: 8,
  },
];
