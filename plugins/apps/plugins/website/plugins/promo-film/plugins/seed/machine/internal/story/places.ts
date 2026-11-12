import type { SeedTagKey } from "@plugins/apps/plugins/places/plugins/places-core/server";

// The film's saved places: a Parisian's, years of them — the neighbourhood,
// the concert halls they go to or want to, last May's Lisbon trip, July's
// Bergen and further afield — so a zoom out from Paris lands on a Europe full
// of the user's own pins. Each is a real Google place, saved by id:
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

/** Last May's trip to Lisbon. */
const LISBON_PLACES: readonly FilmPlace[] = [
  {
    googlePlaceId: "ChIJNTZ10A0zGQ0ROwhyCh2mkwg", // Museu Calouste Gulbenkian Lisboa
    tags: ["been", "museum", "art"],
    icon: "palette",
    note: "The garden first, then the Lalique room.",
    savedDaysAgo: 190,
  },
  {
    googlePlaceId: "ChIJkfTl003LHg0RxFtZGUxQE8s", // MAAT Lisboa
    tags: ["been", "museum", "art"],
    icon: "museum",
    note: "Walk along the river from Belém.",
    savedDaysAgo: 190,
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
    tags: ["been", "attraction"],
    icon: "castle",
    note: "",
    savedDaysAgo: 190,
  },
  {
    googlePlaceId: "ChIJV32DNI8zGQ0R9GqiWeuNH2E", // Miradouro da Senhora do Monte
    tags: ["been", "outdoors"],
    icon: "landscape",
    note: "Sunset. Worth the climb.",
    savedDaysAgo: 190,
  },
  {
    googlePlaceId: "ChIJ-R6VlIUzGQ0RX8x1jtg9lh0", // Cervejaria Ramiro Lisboa
    tags: ["been", "food", "restaurant"],
    icon: "set-meal",
    note: "The garlic prawns.",
    savedDaysAgo: 190,
  },
  {
    googlePlaceId: "ChIJdWBeWYc0GQ0RktxySU7hjxM", // Time Out Market Lisboa
    tags: ["been", "food"],
    icon: "restaurant",
    note: "",
    savedDaysAgo: 190,
  },
  {
    googlePlaceId: "ChIJTRo64mU1GQ0RfEYk1nPW13c", // Park Bar Lisboa
    tags: ["been", "bar"],
    icon: "local-bar",
    note: "On top of a car park, ask for the lift.",
    savedDaysAgo: 190,
  },
  {
    googlePlaceId: "ChIJ5dveYa80GQ0RrEP1FKqq6zM", // LX Factory
    tags: ["been", "shop"],
    icon: "storefront",
    note: "Ler Devagar bookshop.",
    savedDaysAgo: 190,
  },
  {
    googlePlaceId: "ChIJqzZCU2MzGQ0RkegDvwGR1ys", // Jardim da Estrela Lisboa
    tags: ["been", "outdoors"],
    icon: "park",
    note: "",
    savedDaysAgo: 190,
  },
];

/** Music: the halls the user goes to, or wants to — Paris and across Europe. */
const MUSIC_PLACES: readonly FilmPlace[] = [
  {
    googlePlaceId: "ChIJA0Kr5chv5kcRufAlf3vuXsM", // Salle Gaveau
    tags: ["been", "shows"],
    icon: "piano",
    note: "Best seats: balcony, left side.",
    savedDaysAgo: 300,
  },
  {
    googlePlaceId: "ChIJP1IC2bVt5kcRNmL7ZmRb7hE", // Philharmonie de Paris
    tags: ["been", "shows"],
    icon: "music-note",
    note: "",
    savedDaysAgo: 420,
  },
  {
    googlePlaceId: "ChIJm46nd5H5PEYRBnw82R8cUQg", // Troldhaugen, Bergen
    tags: ["want", "shows", "museum"],
    icon: "piano",
    note: "Grieg's house. Lunchtime concerts in Troldsalen, July.",
    savedDaysAgo: 20,
  },
  {
    googlePlaceId: "ChIJ-dNEa9MadkgRNYqylAShZqU", // Wigmore Hall, London
    tags: ["want", "shows"],
    icon: "music-note",
    note: "",
    savedDaysAgo: 150,
  },
  {
    googlePlaceId: "ChIJx-raUZ0HbUcRT4MxN8ArwYI", // Musikverein, Vienna
    tags: ["want", "shows"],
    icon: "music-note",
    note: "New Year's concert, one day.",
    savedDaysAgo: 600,
  },
  {
    googlePlaceId: "ChIJw6RppvoJxkcR6ZFbJ2aUYDM", // Concertgebouw, Amsterdam
    tags: ["been", "shows"],
    icon: "music-note",
    note: "",
    savedDaysAgo: 800,
  },
  {
    googlePlaceId: "ChIJK_QFBbZRqEcRZgBlwtwfnv0", // Philharmonie Berlin
    tags: ["want", "shows"],
    icon: "music-note",
    note: "",
    savedDaysAgo: 240,
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
  ...MUSIC_PLACES,
  ...LISBON_PLACES,
  ...ELSEWHERE,
];
