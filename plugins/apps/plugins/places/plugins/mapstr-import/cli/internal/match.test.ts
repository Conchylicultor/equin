import { describe, expect, test } from "bun:test";
import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";
import {
  addressCityTokens,
  insideArea,
  distanceM,
  languageForAddress,
  nameSimilarity,
  nameTokens,
  pickCandidate,
  tokensMatch,
} from "./match";

// ~0.0009° latitude ≈ 100 m.
const M = 0.0009 / 100;
const BASE = { lat: 48.8597688, lng: 2.4046142 };

/** A Mapstr place at BASE. */
const at = (name: string, address = "75011 Paris") => ({
  name,
  address,
  ...BASE,
});
/** A Google hit `metres` north of BASE. */
const hit = (
  name: string,
  metres = 0,
  types: string[] = ["point_of_interest", "establishment"],
  placeId = name,
): PlaceCandidate => ({
  placeId,
  name,
  lat: BASE.lat + metres * M,
  lng: BASE.lng,
  types,
});

const decide = (name: string, address: string, ...hits: PlaceCandidate[]) =>
  pickCandidate(at(name, address), [{ candidates: hits }]);

test("distance is metres along the great circle", () => {
  expect(
    Math.round(distanceM(BASE, { lat: BASE.lat + 100 * M, lng: BASE.lng })),
  ).toBe(100);
  const london = { lat: 51.5074, lng: -0.1278 };
  expect(
    Math.round(distanceM({ lat: 48.8566, lng: 2.3522 }, london) / 1000),
  ).toBe(344);
});

test("names fold accents, ß, apostrophes, stopwords and generic words", () => {
  expect(nameTokens("CHEZ POM’")).toEqual(["chez", "pom"]);
  expect(nameTokens("Le Coucou")).toEqual(["coucou"]);
  expect(nameTokens("Schloß Dammsmühle")).toEqual(["schloss", "dammsmuhle"]);
  expect(nameTokens("SAGE Restaurant")).toEqual(["sage"]);
  // Never down to nothing.
  expect(nameTokens("La")).toEqual(["la"]);
  expect(nameTokens("Le Bar")).toEqual(["bar"]);
  expect(nameTokens("Musée Bourdelle")).toEqual(["bourdelle"]);
});

test("tokens match through typos and spelling variants, numbers exactly", () => {
  expect(tokensMatch("chappelle", "chapelle")).toBe(true);
  expect(tokensMatch("skogarfoss", "skogafoss")).toBe(true);
  expect(tokensMatch("gemuese", "gemuse")).toBe(true);
  expect(tokensMatch("koenig", "konig")).toBe(true);
  expect(tokensMatch("75011", "75012")).toBe(false);
  expect(tokensMatch("bar", "bat")).toBe(false);
});

test("the address's city is generic for that place", () => {
  expect([
    ...addressCityTokens("Chamissoplatz 1, Kreuzberg, 10965 Berlin, Germany"),
  ]).toEqual(["berlin"]);
  expect(nameSimilarity("Restaurant Namsan", "Namsan Berlin")).toBe(1);
});

describe("pickCandidate", () => {
  test("picks the most alike hit within range, then the nearest", () => {
    const decision = pickCandidate(at("Lithium Café - Radio"), [
      {
        candidates: [
          hit("Lithium Café", 1100, undefined, "far"),
          hit("Boulangerie Saint-Blaise", 10),
        ],
      },
      { candidates: [hit("Lithium Café", 56, undefined, "it")] },
    ]);
    expect(decision).toEqual({
      kind: "matched",
      googlePlaceId: "it",
      googleName: "Lithium Café",
      distanceM: 56,
      similarity: 1,
      basis: "name",
    });
  });

  test("a hit found twice is scored on its best name (the language re-search)", () => {
    const decision = pickCandidate(
      at("Tour Montparnasse", "33 Avenue du Maine, 75015 Paris"),
      [
        { candidates: [hit("Montparnasse Tower", 0, undefined, "g")] },
        { candidates: [hit("Tour Montparnasse", 0, undefined, "g")] },
      ],
    );
    expect(decision).toMatchObject({
      kind: "matched",
      googleName: "Tour Montparnasse",
    });
  });

  // Real rows the first matcher missed.
  test.each([
    [
      "Musée Bourdelle",
      "16-18 Rue Antoine Bourdelle, 75015 Paris",
      "Bourdelle Museum",
      0,
    ],
    [
      "Musée Fragonard",
      "7 Avenue du Général de Gaulle, 94700 Maisons-Alfort",
      "Fragonard Museum",
      42,
    ],
    [
      "Schloß Dammsmühle",
      "Schloßstraße 16348 Wandlitz",
      "Schloss Dammsmühle",
      1,
    ],
    [
      "Sainte-Chappelle",
      "8 Boulevard du Palais Paris France",
      "Sainte-Chapelle",
      0,
    ],
    ["Skógarfoss", "861 Rangárþing Eystra Iceland", "Skógafoss", 0],
    [
      "Mustafa's Gemuese Kebab",
      "MehringDamm 32 Berlin Germany",
      "Mustafa's Gemüse Kebap",
      0,
    ],
    [
      "SAGE Restaurant",
      "Köpenicker Straße 18, Kreuzberg, 10997 Berlin, Germany",
      "SAGE Berlin",
      0,
    ],
    [
      "Restaurant Namsan",
      "Chamissoplatz 1, Kreuzberg, 10965 Berlin, Germany",
      "Namsan Berlin",
      0,
    ],
    [
      "Republik Berlin",
      "Köpenicker Straße 74, 10179 Berlin, Deutschland",
      "Republic Berlin",
      14,
    ],
    [
      "Schneeweiss",
      "Simplonstraße 16, 10245 Berlin, Germany",
      "Restaurant Schneeweiß",
      0,
    ],
    [
      "Koenig Galerie",
      "AlexandrinenStraße Kreuzberg, 10969 Berlin Germany",
      "KÖNIG GALERIE",
      0,
    ],
    [
      "Planten un Blomen",
      "Sankt Petersburger Straße 22, 20355 Hambourg",
      "Planten un Blomen",
      198,
    ],
    [
      "Guédelon",
      "89520 Treigny-Perreuse-Sainte-Colombe France",
      "Guédelon",
      232,
    ],
    [
      "Britzer Garden",
      "Birne Britz, 12349 Berlin Germany",
      "Britzer Garten",
      559,
    ],
    ["Musa Bar", "117 Rue St-Maur, 75011 Paris", "MUSA - Oberkampf", 0],
  ])("%s ≈ %s", (name, address, google, metres) => {
    expect(decide(name, address, hit(google, metres))).toMatchObject({
      kind: "matched",
    });
  });

  test("far away, the names must agree both ways", () => {
    // The user's examples of big sites slightly far.
    expect(
      decide(
        "Jardins du château de Versailles",
        "Place d'Armes, 78000 Versailles",
        hit("Jardins de Versailles", 429),
      ).kind,
    ).toBe("matched");
    expect(
      decide(
        "Phantom",
        "8 Boulevard de Bercy, 75012 Paris",
        hit("Phantom Paris", 230),
      ).kind,
    ).toBe("matched");
    // Real false positives of a containment-only far tier.
    for (const [name, address, google, metres] of [
      [
        "The Rice Burger",
        "1 Rue Martel, 75010 Paris",
        "Rice & Burger Kitchen",
        596,
      ],
      [
        "Marché de Rungis",
        "28 Rue Notre Dame, 94150 Rungis",
        "Petit marché de Rungis",
        422,
      ],
      [
        "Athera",
        "69003 Lyon",
        "ATHEKA - Prêt immobilier & Assurance Emprunteur",
        848,
      ],
      ["Spreewald", "Spreewald, Germany", "Spreewald Haus Boche", 570],
      [
        "Secret Cinéma",
        "Near Hungerford Bridge, London, SE1 8",
        "Secret London",
        632,
      ],
    ] as const) {
      expect(decide(name, address, hit(google, metres)).kind).toBe("unmatched");
    }
  });

  test("within 500 m, half of the user's words must be in Google's name", () => {
    expect(
      decide(
        "Vabali Spa Berlin",
        "Seydlitzstraße 6, 10557 Berlin, Germany",
        hit("Vabali", 155),
      ).kind,
    ).toBe("matched");
    expect(
      decide(
        "VDNG - All Russia Exhibition Center",
        "Академіка Глушкова проспект, 1 Kyiv 03127 Ukraine",
        hit("VDNG", 222),
      ).kind,
    ).toBe("unmatched");
  });

  test("a car park named after the place is not the place", () => {
    expect(
      decide(
        "Cité de l'Automobile",
        "17 rue De La Mertzau Mulhouse 68100",
        hit("Parking de la Cité de l'automobile", 100, [
          "parking",
          "establishment",
        ]),
      ),
    ).toEqual({ kind: "unmatched", reason: "only car parks found" });
  });

  test("an address-only hit is a match when the user saved that address", () => {
    for (const [name, google, types] of [
      ["Rue Crémieux", "Rue Crémieux", ["route"]],
      ["Gendarmenmarkt", "Gendarmenmarkt", ["route"]],
      [
        "Beelitz Heilstätten",
        "Beelitz-Heilstätten",
        ["sublocality", "political"],
      ],
      ["Athens", "Athens", ["locality", "political"]],
    ] as const) {
      expect(
        decide(name, "75012 Paris", hit(google, 50, [...types])).kind,
      ).toBe("matched");
    }
    // A street named after the place is still not the place.
    expect(
      decide(
        "Hahneberg",
        "Hahnebergweg Staaken, 13593 Berlin Germany",
        hit("Hahnebergweg", 400, ["route"]),
      ),
    ).toEqual({
      kind: "unmatched",
      reason: 'Google only knows the address ("Hahnebergweg")',
    });
  });

  describe("areas", () => {
    /** An area hit `metres` north of BASE whose viewport spans `km` around its point. */
    const area = (
      name: string,
      types: string[],
      km: number,
      metres = 0,
    ): PlaceCandidate => {
      const center = hit(name, metres, types);
      return {
        ...center,
        viewport: {
          low: { lat: center.lat - km * 1000 * M, lng: center.lng - km / 70 },
          high: { lat: center.lat + km * 1000 * M, lng: center.lng + km / 70 },
        },
      };
    };

    test("a town or park holding the pin matches however far its point", () => {
      expect(
        decide(
          "Athens",
          "Athens, Greece",
          area("Athens", ["locality", "political"], 10, 1048),
        ),
      ).toMatchObject({ kind: "matched", basis: "area" });
      expect(
        decide(
          "Parc des Buttes-Chaumont",
          "1 Rue Botzaris, 75019 Paris",
          area(
            "Parc des Buttes-Chaumont",
            ["park", "point_of_interest"],
            1.5,
            1200,
          ),
        ),
      ).toMatchObject({ kind: "matched", basis: "area" });
      // Without a viewport, the type's radius: a country reaches 500 km.
      expect(
        decide(
          "Portugal",
          "Portugal",
          hit("Portugal", 200_000, ["country", "political"]),
        ),
      ).toMatchObject({ kind: "matched", basis: "area" });
    });

    test("an area that does not hold the pin, or is named otherwise, is not it", () => {
      expect(
        decide(
          "Toscana",
          "Italy",
          area("Toscana", ["administrative_area_level_1"], 1, 50_000),
        ).kind,
      ).toBe("unmatched");
      // The garden next door, even first in a name-only search.
      expect(
        pickCandidate(
          at("Jardins de l'Île Seguin", "92100 Boulogne-Billancourt"),
          [
            {
              nameOnly: true,
              candidates: [area("Jardin Bellini", ["park"], 0.3, 207)],
            },
          ],
        ).kind,
      ).toBe("unmatched");
      // "Park" says what, not which: "Tempelhofer Park" is the "Tempelhofer Feld".
      expect(
        decide(
          "Tempelhofer Park",
          "12101 Berlin",
          area("Tempelhofer Feld", ["park"], 2),
        ).kind,
      ).toBe("matched");
    });

    test("the first hit of a name-only search, an area holding the pin, is a translation", () => {
      const portogallo = at("Portogallo", "Portugal");
      const portugal = area("Portugal", ["country", "political"], 300);
      expect(
        pickCandidate(portogallo, [{ nameOnly: true, candidates: [portugal] }]),
      ).toMatchObject({
        kind: "matched",
        basis: "translation",
        googleName: "Portugal",
      });
      // Not first, or not from a name-only search: not taken on faith.
      expect(pickCandidate(portogallo, [{ candidates: [portugal] }]).kind).toBe(
        "unmatched",
      );
      expect(
        pickCandidate(portogallo, [
          {
            nameOnly: true,
            candidates: [hit("Porto Gallo Bar", 5000), portugal],
          },
        ]).kind,
      ).toBe("unmatched");
      // A shop first in a name-only search is never a translation.
      expect(
        pickCandidate(at("Bunker WWII", "75010 Paris"), [
          { nameOnly: true, candidates: [hit("Gare de l'Est", 62)] },
        ]).kind,
      ).toBe("unmatched");
    });

    test("insideArea pads the viewport and handles the antimeridian", () => {
      const fiji: PlaceCandidate = {
        ...hit("Fiji", 0, ["country"]),
        viewport: {
          low: { lat: -21, lng: 176 },
          high: { lat: -12, lng: -178 },
        },
      };
      expect(insideArea({ lat: -17, lng: 179 }, fiji)).toBe(true);
      expect(insideArea({ lat: -17, lng: -179 }, fiji)).toBe(true);
      expect(insideArea({ lat: -17, lng: 170 }, fiji)).toBe(false);
      expect(insideArea(BASE, hit("A shop", 0))).toBe(false);
    });
  });

  test("abbreviations are spelt out: the user saved that address", () => {
    expect(
      decide(
        "108 Rue St-Maur",
        "75011 Paris",
        hit("108 Rue Saint-Maur", 20, ["street_address"]),
      ),
    ).toMatchObject({ kind: "matched", basis: "name" });
  });

  test("a translated name not re-searched yet stays unmatched", () => {
    expect(
      decide(
        "Fernsehturm",
        "PanoramaStraße 1A Berlin Germany",
        hit("Berlin TV Tower"),
      ),
    ).toEqual({
      kind: "unmatched",
      reason: 'name mismatch: nearest "Berlin TV Tower" (0 m) Berlin TV Tower',
    });
  });

  // Real rows that MUST stay unmatched: another business at the same spot.
  test.each([
    [
      "Katjusha",
      "Neue Bahnhofstraße 23 Friedrichshain, 10245 Berlin",
      "HOME Bar",
      12,
    ],
    ["The Rice Burger", "1 Rue Martel, 75010 Paris", "Chez Marie, paris 10", 0],
    ["Ken Kawasaki", "15 Rue Caulaincourt, 75018 Paris", "Kiyo Aji", 2],
    [
      "Malor",
      "Bellermannstraße 98 Gesundbrunnen, 13357 Berlin Germany",
      "Afro-Mixx",
      0,
    ],
    [
      "5 Places",
      "Simon-Dach-Straße 30 Friedrichshain, 10245 Berlin Germany",
      "Haarwerkstatt",
      8,
    ],
    [
      "Kobuta",
      "Near Sonntagstraße 30, 10245 Berlin, Germany",
      "THE FACTORY PIZZA & PASTA",
      16,
    ],
    [
      "Icebar London",
      "31–33 Heddon Street, Mayfair, W1B 4BN, England",
      "Fire Bar",
      0,
    ],
    [
      "Marché de Rungis",
      "28 Rue Notre Dame, 94150 Rungis",
      "Restaurant L'ESCALET",
      5,
    ],
    [
      "Café de Flore",
      "172 Boulevard Saint-Germain, 75006 Paris",
      "Café Charlot",
      20,
    ],
  ])("%s ≠ %s", (name, address, google, metres) => {
    const decision = decide(name, address, hit(google, metres));
    expect(decision.kind).toBe("unmatched");
    if (decision.kind === "unmatched")
      expect(decision.reason).toContain("name mismatch");
  });

  // Real rows where Google only answered with the address.
  test.each([
    [
      "La Borne",
      "Near 12 Grand Route, 18250 Henrichemont",
      "12 Grand Route",
      ["street_address"],
    ],
    [
      "Freetown Christiania",
      "Psyak 3, 1440 København K, Denmark",
      "Psyak 3",
      ["premise"],
    ],
    [
      "Cité Florale",
      "Rue des Glycines 75013 Paris France",
      "Rue des Glycines",
      ["route"],
    ],
    [
      "Panke river",
      "Near Kunkelstraße 1, 13347 Berlin, Germany",
      "Kunkelstraße 1",
      ["street_address"],
    ],
    ["Bourges", "18000 Bourges", "18000", ["postal_code"]],
  ])("%s → only the address %s", (name, address, google, types) => {
    expect(decide(name, address, hit(google, 20, types))).toEqual({
      kind: "unmatched",
      reason: `Google only knows the address ("${google}")`,
    });
  });

  test("other unmatched reasons", () => {
    expect(pickCandidate(at("Riv'K"), [{ candidates: [] }])).toEqual({
      kind: "unmatched",
      reason: "no results",
    });
    const far = decide(
      "Lithium Café",
      "75020 Paris",
      hit("Lithium Café", 1200),
    );
    expect(far.kind === "unmatched" && far.reason).toMatch(
      /^too far: "Lithium Café" 120\d m \(name 100%, its words in ours 100%\) Lithium Café$/,
    );
    // A close-enough name is not enough beyond 150 m.
    expect(
      decide("Petit Nuage Club", "75011 Paris", hit("Petit Nuage", 200)).kind,
    ).toBe("matched");
    expect(
      decide("Bar Petit Nuage Nord", "75011 Paris", hit("Petit Nuage Sud", 200))
        .kind,
    ).toBe("unmatched");
  });
});

test("the language a place is re-searched in comes from its address", () => {
  expect(languageForAddress("16-18 Rue Antoine Bourdelle, 75015 Paris")).toBe(
    "fr",
  );
  expect(languageForAddress("86360 Chasseneuil-du-Poitou")).toBe("fr");
  expect(languageForAddress("PanoramaStraße 1A Berlin Germany")).toBe("de");
  expect(languageForAddress("Alter Wandrahm 4 Hafencity, 20457 Hambourg")).toBe(
    "de",
  );
  expect(languageForAddress("Tøjhusgade 3, 1214 København K, Danmark")).toBe(
    "da",
  );
  expect(languageForAddress("861 Rangárþing Eystra Iceland")).toBe("is");
  expect(
    languageForAddress("Voorsterweg 34, 8316 PT Marknesse, Pays-Bas"),
  ).toBe("nl");
  expect(languageForAddress("Via Piramidi 39054 Renon Italy")).toBe("it");
  expect(
    languageForAddress("Sanam Chai Road, Bangkok, Thailand"),
  ).toBeUndefined();
});
