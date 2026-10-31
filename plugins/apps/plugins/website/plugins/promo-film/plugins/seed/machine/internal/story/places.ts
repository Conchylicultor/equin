import type { SeedTagKey } from "@plugins/apps/plugins/places/plugins/places-core/server";

// The film's saved places: a trip to Lisbon being planned (most still to go),
// and the places of earlier trips and future ones across the world, so the
// map has somewhere to zoom out to. Each is a real Google place, saved by id:
// the seed fetches its details through the importer's own path (one Place
// Details call each, on the host's Places key), so the cards show Google's
// own name, address, kind and — fetched by the app on view — its photo. The
// icon is given, so no Haiku pick runs and every seed draws the same map.

export interface FilmPlace {
  /** A Google Places id (looked up once by name; stable). */
  googlePlaceId: string;
  tags: readonly SeedTagKey[];
  /** A Material Symbols name, checked at seed (`parseSavedSymbolName`). */
  icon: string;
  note: string;
  /** Days before the seed it was saved. */
  savedDaysAgo: number;
}

/** The Lisbon trip the film plans. */
export const LISBON_PLACES: readonly FilmPlace[] = [
  {
    googlePlaceId: "ChIJNTZ10A0zGQ0ROwhyCh2mkwg", // Museu Calouste Gulbenkian Lisboa
    tags: ["want", "museum", "art"],
    icon: "palette",
    note: "Friday morning, booked.",
    savedDaysAgo: 12,
  },
  {
    googlePlaceId: "ChIJkfTl003LHg0RxFtZGUxQE8s", // MAAT Lisboa
    tags: ["want", "museum", "art"],
    icon: "museum",
    note: "Walk along the river from Belém.",
    savedDaysAgo: 12,
  },
  {
    googlePlaceId: "ChIJS5zCw0LLHg0RP1FSz63cAjA", // Torre de Belém
    tags: ["been", "attraction"],
    icon: "fort",
    note: "",
    savedDaysAgo: 400,
  },
  {
    googlePlaceId: "ChIJW3H9LkXLHg0RZZZttMb27_8", // Pastéis de Belém
    tags: ["been", "food", "snacks"],
    icon: "bakery-dining",
    note: "Go early, the queue moves fast anyway.",
    savedDaysAgo: 400,
  },
  {
    googlePlaceId: "ChIJm8MOtHc0GQ0R1zPkmUFwwLQ", // Castelo de São Jorge
    tags: ["want", "attraction"],
    icon: "castle",
    note: "",
    savedDaysAgo: 12,
  },
  {
    googlePlaceId: "ChIJV32DNI8zGQ0R9GqiWeuNH2E", // Miradouro da Senhora do Monte
    tags: ["want", "outdoors"],
    icon: "landscape",
    note: "Sunset, take the 28 tram up.",
    savedDaysAgo: 12,
  },
  {
    googlePlaceId: "ChIJ-R6VlIUzGQ0RX8x1jtg9lh0", // Cervejaria Ramiro Lisboa
    tags: ["want", "food", "restaurant"],
    icon: "set-meal",
    note: "Saturday dinner. The garlic prawns.",
    savedDaysAgo: 12,
  },
  {
    googlePlaceId: "ChIJdWBeWYc0GQ0RktxySU7hjxM", // Time Out Market Lisboa
    tags: ["want", "food"],
    icon: "restaurant",
    note: "",
    savedDaysAgo: 12,
  },
  {
    googlePlaceId: "ChIJTRo64mU1GQ0RfEYk1nPW13c", // Park Bar Lisboa
    tags: ["want", "bar"],
    icon: "local-bar",
    note: "On top of a car park, ask for the lift.",
    savedDaysAgo: 12,
  },
  {
    googlePlaceId: "ChIJ5dveYa80GQ0RrEP1FKqq6zM", // LX Factory
    tags: ["want", "shop"],
    icon: "storefront",
    note: "Ler Devagar bookshop.",
    savedDaysAgo: 12,
  },
  {
    googlePlaceId: "ChIJqzZCU2MzGQ0RkegDvwGR1ys", // Jardim da Estrela Lisboa
    tags: ["want", "outdoors"],
    icon: "park",
    note: "",
    savedDaysAgo: 12,
  },
];

/** Elsewhere: been and still to go. */
const ELSEWHERE: readonly FilmPlace[] = [
  {
    googlePlaceId: "ChIJG5Qwtitu5kcR2CNEsYy9cdA", // Musée d'Orsay Paris
    tags: ["been", "museum", "art"],
    icon: "palette",
    note: "",
    savedDaysAgo: 700,
  },
  {
    googlePlaceId: "ChIJ_7ZXHuFx5kcRs1LnTeCsOBM", // Shakespeare and Company Paris
    tags: ["been", "shop"],
    icon: "local-library",
    note: "",
    savedDaysAgo: 700,
  },
  {
    googlePlaceId: "ChIJe2jeNttx5kcRi_mJsGHdkQc", // Jardin du Luxembourg
    tags: ["been", "outdoors"],
    icon: "park",
    note: "",
    savedDaysAgo: 700,
  },
  {
    googlePlaceId: "ChIJZbQv_-dx5kcRARl8yz3wTu0", // Le Comptoir du Panthéon Paris
    tags: ["want", "food", "restaurant"],
    icon: "restaurant",
    note: "",
    savedDaysAgo: 90,
  },
  {
    googlePlaceId: "ChIJk_s92NyipBIRUMnDG8Kq2Js", // Sagrada Família
    tags: ["been", "attraction"],
    icon: "church",
    note: "",
    savedDaysAgo: 900,
  },
  {
    googlePlaceId: "ChIJAVoetfeipBIR1a1z3FTGCoY", // Mercat de la Boqueria
    tags: ["been", "food"],
    icon: "storefront",
    note: "",
    savedDaysAgo: 900,
  },
  {
    googlePlaceId: "ChIJq0HUUq6ipBIRWM6qGqALmok", // Park Güell
    tags: ["want", "outdoors"],
    icon: "park",
    note: "",
    savedDaysAgo: 60,
  },
  {
    googlePlaceId: "ChIJIW0uPRUPAWAR6eI6dRzKGns", // Fushimi Inari Taisha
    tags: ["want", "attraction"],
    icon: "temple-buddhist",
    note: "Go at dawn, before the crowds.",
    savedDaysAgo: 200,
  },
  {
    googlePlaceId: "ChIJvUbrwCCoAWARX2QiHCsn5A4", // Kinkaku-ji
    tags: ["want", "attraction"],
    icon: "temple-buddhist",
    note: "",
    savedDaysAgo: 200,
  },
  {
    googlePlaceId: "ChIJT8uMzZwIAWARnGzsARCjnrY", // Nishiki Market Kyoto
    tags: ["want", "food"],
    icon: "storefront",
    note: "",
    savedDaysAgo: 200,
  },
  {
    googlePlaceId: "ChIJb8Jg9pZYwokR-qHGtvSkLzs", // The Metropolitan Museum of Art
    tags: ["been", "museum", "art"],
    icon: "museum",
    note: "",
    savedDaysAgo: 1100,
  },
  {
    googlePlaceId: "ChIJCar0f49ZwokR6ozLV-dHNTE", // Katz's Delicatessen
    tags: ["been", "food", "restaurant"],
    icon: "lunch-dining",
    note: "",
    savedDaysAgo: 1100,
  },
  {
    googlePlaceId: "ChIJ5bQPhMdZwokRkTwKhVxhP1g", // The High Line
    tags: ["been", "outdoors"],
    icon: "park",
    note: "",
    savedDaysAgo: 1100,
  },
  {
    googlePlaceId: "ChIJqUCGZ09gLxMRLM42IPpl0co", // Pantheon Rome
    tags: ["been", "attraction"],
    icon: "account-balance",
    note: "",
    savedDaysAgo: 500,
  },
  {
    googlePlaceId: "ChIJ4T6-zEhgLxMRSa1VL3N0DyY", // Roscioli Salumeria con Cucina
    tags: ["want", "food", "restaurant"],
    icon: "restaurant",
    note: "Book a week ahead.",
    savedDaysAgo: 30,
  },
  {
    googlePlaceId: "ChIJOz-6AMT_0YURofTM9_ekAWI", // Museo Frida Kahlo
    tags: ["want", "museum", "art"],
    icon: "palette",
    note: "",
    savedDaysAgo: 45,
  },
  {
    googlePlaceId: "ChIJ8-r2gBJTUkYRsCcLtQ0Ltdk", // Tivoli Gardens Copenhagen
    tags: ["want", "attraction"],
    icon: "attractions",
    note: "",
    savedDaysAgo: 45,
  },
];

export const FILM_PLACES: readonly FilmPlace[] = [
  ...LISBON_PLACES,
  ...ELSEWHERE,
];
