import { z } from "zod";
import type { PlaceCandidate } from "@plugins/integrations/plugins/google-maps/plugins/places-api/core";

/**
 * How a Google hit's name compares to the Mapstr place's (each 0–1).
 *
 * - `similarity`: the share of the SHORTER name's identity tokens (generic
 *   words and the city dropped) found in the other, typos forgiven —
 *   containment, so "Lithium Café - Radio" ≈ "Lithium Café".
 * - `googleCoverage` / `placeCoverage`: the share of the Google / Mapstr name's
 *   own words (only stopwords and big-city names dropped, no prefix leeway)
 *   found in the other.
 *   Google's name saying MORE than the user's ("PETIT marché de Rungis",
 *   "Rice & Burger KITCHEN") names another, more specific place; the user's
 *   saying more ("Jardins du CHÂTEAU de Versailles") is just their wording.
 */
export interface NameMatch {
  similarity: number;
  googleCoverage: number;
  placeCoverage: number;
}

/**
 * What a hit needs, by how far it is from the Mapstr pin. Close, a similar name
 * will do. Farther (a park, a castle, a big site whose Google point is hundreds
 * of metres from the pin) every word of Google's name must be in the user's
 * and half of the user's in Google's; farther still, the names must agree both
 * ways. `minSimilarity` stays above
 * one half on purpose: "Café de Flore" next to "Café Charlot" shares one of two
 * words and is not the place.
 */
export const MATCH_TIERS = [
  {
    minSimilarity: 0.6,
    minGoogleCoverage: 0,
    minPlaceCoverage: 0,
    maxDistanceM: 150,
  },
  {
    minSimilarity: 0.85,
    minGoogleCoverage: 0.99,
    minPlaceCoverage: 0.5,
    maxDistanceM: 500,
  },
  {
    minSimilarity: 0.85,
    minGoogleCoverage: 0.99,
    minPlaceCoverage: 0.99,
    maxDistanceM: 1000,
  },
] as const;

/**
 * A hit Google types only as a street-level address (`isStreetLevel`: "108
 * Rue Saint-Maur", a postcode) is a match only when the user saved that very
 * address: every word of it is in their name. Otherwise Google found the
 * address of the place ("Psyak 3" for Freetown Christiania), not the place.
 */
const ADDRESS_MATCH = { minSimilarity: 0.85, minGoogleCoverage: 0.99 } as const;

/**
 * An area hit (a town, a park, a country — `isArea`) holding the pin matches,
 * however far its point is, when named the user's way: near-certain name, every
 * word of Google's in the user's.
 */
const AREA_MATCH = { minSimilarity: 0.85, minGoogleCoverage: 0.99 } as const;

/** Why a hit was taken — see `pickCandidate`. */
export const MATCH_BASES = ["name", "area", "translation"] as const;
export type MatchBasis = (typeof MATCH_BASES)[number];

/**
 * What phase A decided for one Mapstr place — a schema because it round-trips
 * through the matches file.
 */
export const MatchDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("matched"),
    googlePlaceId: z.string().min(1),
    googleName: z.string(),
    distanceM: z.number(),
    similarity: z.number(),
    /** Absent on decisions made before bases existed: `name`. */
    basis: z.enum(MATCH_BASES).optional(),
  }),
  z.object({ kind: z.literal("unmatched"), reason: z.string() }),
]);

export type MatchDecision = z.infer<typeof MatchDecisionSchema>;

interface Point {
  lat: number;
  lng: number;
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: Point, b: Point): number {
  const R = 6_371_000;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Words that carry no identity in a place name ("Le Coucou" is "Coucou").
const STOPWORDS = new Set(
  "le la les l de du des d et a au aux the an of and der die das den dem am im zum zur von und".split(
    " ",
  ),
);

// Words that say WHAT a place is or WHERE, not WHICH one: "SAGE Restaurant" is
// Google's "SAGE Berlin". Dropped before scoring — never down to no token.
const CITY_WORDS = new Set(
  "paris berlin hamburg hambourg london londres lyon kobenhavn copenhagen amsterdam munchen munich wien vienna roma rome".split(
    " ",
  ),
);
const GENERIC = new Set([
  ..."restaurant cafe coffee bar museum musee museo museu muzeum park parc".split(
    " ",
  ),
  ...CITY_WORDS,
]);

/** Letters NFD does not decompose, spelled the way the other spelling would. */
const LETTER_FOLDS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  þ: "th",
  ð: "d",
  ł: "l",
  đ: "d",
};

/**
 * A name's raw tokens: accents folded (ß → ss, ü → u), lowercased, apostrophes
 * joined ("Pom’" → "pom"), everything else non-alphanumeric a separator.
 */
function rawTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[ßæœøþðłđ]/g, (ch) => LETTER_FOLDS[ch] ?? ch)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/['’`]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "")
    .map((token) => ABBREVIATIONS[token] ?? token);
}

/** Abbreviations spelt out, so "Rue St-Maur" is "Rue Saint-Maur". */
const ABBREVIATIONS: Record<string, string> = {
  st: "saint",
  ste: "sainte",
  bd: "boulevard",
  av: "avenue",
  ave: "avenue",
  pl: "place",
  str: "strasse",
  gds: "grands",
  mt: "mont",
};

/**
 * A name's identity tokens: stopwords and generic words (`GENERIC`, plus
 * `extraGeneric` — the place's city) dropped, falling back a step whenever a
 * drop would leave nothing ("Le Bar" keeps "bar").
 */
export function nameTokens(
  name: string,
  extraGeneric: ReadonlySet<string> = new Set(),
): string[] {
  const tokens = rawTokens(name);
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  if (meaningful.length === 0) return tokens;
  const specific = meaningful.filter(
    (t) => !GENERIC.has(t) && !extraGeneric.has(t),
  );
  return specific.length > 0 ? specific : meaningful;
}

/** Edit distance, stopping early once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length] ?? max + 1;
}

/**
 * Two tokens are the same word, spelt alike: equal, or (words, not numbers) a
 * typo / spelling variant apart — one edit from 5 letters ("chappelle" ~
 * "chapelle", "gemuese" ~ "gemuse"), two from 9.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = short === a ? b : a;
  // Numbers are exact: "75011" is not "75012".
  if (!/\p{L}/u.test(short)) return false;
  const max = short.length >= 9 ? 2 : short.length >= 5 ? 1 : 0;
  return max > 0 && editDistance(short, long, max) <= max;
}

/**
 * Two tokens name the same thing: `sameWord`, or one a 4+ character prefix of
 * the other ("cafe" ~ "cafes").
 */
export function tokensMatch(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return sameWord(a, b) || (short.length >= 4 && long.startsWith(short));
}

/**
 * A name's words, only stopwords and big-city names dropped (never down to
 * none): "Phantom Paris" says no more than "Phantom". The address's own town
 * stays — "Jardins de VERSAILLES" names the town's gardens.
 */
function plainTokens(name: string): string[] {
  const tokens = rawTokens(name);
  const meaningful = tokens.filter(
    (t) => !STOPWORDS.has(t) && !CITY_WORDS.has(t),
  );
  return meaningful.length > 0 ? meaningful : tokens;
}

/** The share of `from` found in `to`; 1 when both spell the same letters. */
function coverage(from: string[], to: string[]): number {
  if (from.length === 0) return 0;
  if (from.join("") === to.join("")) return 1;
  return (
    from.filter((x) => to.some((y) => sameWord(x, y))).length / from.length
  );
}

/**
 * How the Google name `googleName` compares to the Mapstr name `placeName`
 * (`NameMatch`). Names equal or containing one another once spaces are gone
 * ("Saint-Pourçain" vs "Saint Pourçain") have similarity 1. `extraGeneric` (the
 * place's city) is dropped for the similarity.
 */
export function nameMatch(
  placeName: string,
  googleName: string,
  extraGeneric: ReadonlySet<string> = new Set(),
): NameMatch {
  const plainPlace = plainTokens(placeName);
  const plainGoogle = plainTokens(googleName);
  const coverages = {
    googleCoverage: coverage(plainGoogle, plainPlace),
    placeCoverage: coverage(plainPlace, plainGoogle),
  };
  const ta = nameTokens(placeName, extraGeneric);
  const tb = nameTokens(googleName, extraGeneric);
  if (ta.length === 0 || tb.length === 0)
    return { similarity: 0, ...coverages };
  const ca = ta.join("");
  const cb = tb.join("");
  const [cs, cl] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  if (cs.length >= 4 && cl.includes(cs)) return { similarity: 1, ...coverages };
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const found = short.filter((x) => long.some((y) => tokensMatch(x, y))).length;
  return { similarity: found / short.length, ...coverages };
}

/** `nameMatch`'s similarity alone. */
export function nameSimilarity(
  placeName: string,
  googleName: string,
  extraGeneric: ReadonlySet<string> = new Set(),
): number {
  return nameMatch(placeName, googleName, extraGeneric).similarity;
}

/** The city words of an address: the word(s) after its postal code, plus known cities. */
export function addressCityTokens(address: string): Set<string> {
  const out = new Set<string>();
  for (const m of address.matchAll(/\b\d{4,5}\s+([^\d,]+)/gu)) {
    for (const token of rawTokens(m[1] ?? "")) out.add(token);
  }
  return out;
}

// Google types of a hit that is only a STREET-LEVEL address (a number in a
// street, a building, a postcode) — never the shop or museum saved there.
const STREET_TYPES = new Set([
  "street_address",
  "street_number",
  "premise",
  "subpremise",
  "intersection",
  "postal_code",
  "postal_code_prefix",
  "postal_code_suffix",
  "plus_code",
  "geocode",
  "political",
  "floor",
  "room",
  "post_box",
]);

/** A hit typed only as a street-level address (`STREET_TYPES`). */
export function isStreetLevel(candidate: PlaceCandidate): boolean {
  return (
    candidate.types.length > 0 &&
    candidate.types.every((t) => STREET_TYPES.has(t))
  );
}

/**
 * Places that are AREAS — a country, a town, a district, a park, a road — and
 * how far from their point a pin inside them can be, when Google gives no
 * viewport. First matching type wins (most specific first).
 */
const AREA_RADIUS_M: readonly [RegExp, number][] = [
  [/^(route)$/, 2_000],
  [/^(sublocality(_level_\d)?|neighborhood)$/, 5_000],
  [/^(natural_feature|park|national_park|state_park|hiking_area)$/, 20_000],
  [/^(locality|postal_town|colloquial_area)$/, 30_000],
  [/^administrative_area_level_\d$/, 150_000],
  [/^(country|continent|archipelago)$/, 500_000],
];

function areaRadiusM(candidate: PlaceCandidate): number | undefined {
  for (const [pattern, radius] of AREA_RADIUS_M) {
    if (candidate.types.some((t) => pattern.test(t))) return radius;
  }
  return undefined;
}

/**
 * Areas big or distinct enough to be taken on a name-only search's word even
 * when named otherwise ("Portogallo" → "Portugal"). Not a mere park: the first
 * park a garden's name finds may be the garden next door.
 */
const TRANSLATABLE_AREA =
  /^(country|continent|archipelago|administrative_area_level_\d|locality|postal_town|colloquial_area|sublocality(_level_\d)?|neighborhood|natural_feature|national_park|route)$/;

/** A hit that is an area (`AREA_RADIUS_M`). */
export function isArea(candidate: PlaceCandidate): boolean {
  return areaRadiusM(candidate) !== undefined;
}

/**
 * Whether `point` lies within the area `candidate`: inside its viewport padded
 * by a fifth of its size (at least ~500 m), or — no viewport — within its
 * type's radius. Never for a hit that is not an area.
 */
export function insideArea(point: Point, candidate: PlaceCandidate): boolean {
  const radius = areaRadiusM(candidate);
  if (radius === undefined) return false;
  const box = candidate.viewport;
  if (box === undefined) return distanceM(point, candidate) <= radius;
  const MIN_PAD_DEG = 0.005;
  const latPad = Math.max((box.high.lat - box.low.lat) * 0.2, MIN_PAD_DEG);
  const inLat =
    point.lat >= box.low.lat - latPad && point.lat <= box.high.lat + latPad;
  // A box crossing the antimeridian has low.lng > high.lng.
  const span = (box.high.lng - box.low.lng + 360) % 360;
  const lngPad = Math.max(span * 0.2, MIN_PAD_DEG);
  const fromLow = (point.lng - (box.low.lng - lngPad) + 720) % 360;
  return inLat && fromLow <= span + 2 * lngPad;
}

/**
 * A car park named after the place it serves ("Parking de la Cité de
 * l'Automobile") is not that place — unless the user saved a car park.
 */
function isParkingFor(candidate: PlaceCandidate, placeName: string): boolean {
  return (
    candidate.types.includes("parking") &&
    !rawTokens(placeName).includes("parking")
  );
}

/** One Google search made for a place, as `pickCandidate` reads it. */
export interface SearchResult {
  /** Searched by the place's name alone (no address). */
  nameOnly?: boolean;
  candidates: readonly PlaceCandidate[];
}

/**
 * Picks the Google hit that is this Mapstr place, out of every search made for
 * it (a hit found by two searches — in two languages — is scored on its best
 * name). A hit qualifies when:
 *
 * - `name`: its name and distance fit a `MATCH_TIERS` tier (a street-level
 *   address must also pass `ADDRESS_MATCH`: the user saved that address);
 * - `area`: it is an area (a town, a park, a country) whose extent holds the
 *   pin, named the user's way (`AREA_MATCH`);
 * - `translation`: it is the FIRST hit of a name-only search, an area holding
 *   the pin — "Portogallo" is answered "Portugal", "Toscana" "Tuscany".
 *
 * The most alike qualifying hit wins, then the nearest. A car park is never
 * one. Otherwise unmatched, with the reason a human needs to fix it.
 */
export function pickCandidate(
  place: Point & { name: string; address: string },
  searches: readonly SearchResult[],
): MatchDecision {
  const byId = new Map<
    string,
    { candidate: PlaceCandidate; names: string[]; firstOfNameSearch: boolean }
  >();
  for (const search of searches) {
    search.candidates.forEach((candidate, rank) => {
      const first = search.nameOnly === true && rank === 0;
      const seen = byId.get(candidate.placeId);
      if (seen) {
        if (!seen.names.includes(candidate.name))
          seen.names.push(candidate.name);
        seen.firstOfNameSearch ||= first;
      } else {
        byId.set(candidate.placeId, {
          candidate,
          names: [candidate.name],
          firstOfNameSearch: first,
        });
      }
    });
  }
  if (byId.size === 0) return { kind: "unmatched", reason: "no results" };

  const city = addressCityTokens(place.address);
  const scored = [...byId.values()]
    .filter(({ candidate }) => !isParkingFor(candidate, place.name))
    .map(({ candidate, names, firstOfNameSearch }) => {
      const [best] = names
        .map((name) => ({ name, ...nameMatch(place.name, name, city) }))
        .sort(
          (x, y) =>
            y.similarity - x.similarity || y.googleCoverage - x.googleCoverage,
        );
      const s = {
        candidate,
        name: best?.name ?? candidate.name,
        similarity: best?.similarity ?? 0,
        googleCoverage: best?.googleCoverage ?? 0,
        placeCoverage: best?.placeCoverage ?? 0,
        distanceM: Math.round(distanceM(place, candidate)),
      };
      const inside = insideArea(place, candidate);
      const byName =
        MATCH_TIERS.some(
          (tier) =>
            s.similarity >= tier.minSimilarity &&
            s.googleCoverage >= tier.minGoogleCoverage &&
            s.placeCoverage >= tier.minPlaceCoverage &&
            s.distanceM <= tier.maxDistanceM,
        ) &&
        (!isStreetLevel(candidate) ||
          (s.similarity >= ADDRESS_MATCH.minSimilarity &&
            s.googleCoverage >= ADDRESS_MATCH.minGoogleCoverage));
      const basis: MatchBasis | undefined = byName
        ? "name"
        : inside &&
            s.similarity >= AREA_MATCH.minSimilarity &&
            s.googleCoverage >= AREA_MATCH.minGoogleCoverage
          ? "area"
          : inside &&
              firstOfNameSearch &&
              candidate.types.some((t) => TRANSLATABLE_AREA.test(t))
            ? "translation"
            : undefined;
      return { ...s, basis };
    })
    .sort((x, y) => x.distanceM - y.distanceM);

  const [best] = scored
    .filter((s) => s.basis !== undefined)
    .sort(
      (x, y) =>
        BASIS_RANK[x.basis ?? "translation"] -
          BASIS_RANK[y.basis ?? "translation"] ||
        y.similarity - x.similarity ||
        y.googleCoverage - x.googleCoverage ||
        x.distanceM - y.distanceM,
    );
  if (best?.basis !== undefined) {
    return {
      kind: "matched",
      googlePlaceId: best.candidate.placeId,
      googleName: best.name,
      distanceM: best.distanceM,
      similarity: Math.round(best.similarity * 100) / 100,
      basis: best.basis,
    };
  }

  const places = scored.filter((s) => !isAddressLike(s.candidate));
  const [nearest] = places;
  if (nearest === undefined) {
    const [address] = scored;
    return address === undefined
      ? { kind: "unmatched", reason: "only car parks found" }
      : {
          kind: "unmatched",
          reason: `Google only knows the address ("${address.name}")`,
        };
  }
  const minSimilarity = Math.min(...MATCH_TIERS.map((t) => t.minSimilarity));
  const [alike] = places.filter((s) => s.similarity >= minSimilarity);
  if (alike !== undefined) {
    return {
      kind: "unmatched",
      reason: `too far: "${alike.name}" ${alike.distanceM} m (name ${Math.round(alike.similarity * 100)}%, its words in ours ${Math.round(alike.googleCoverage * 100)}%) ${alike.candidate.placeId}`,
    };
  }
  return {
    kind: "unmatched",
    reason: `name mismatch: nearest "${nearest.name}" (${nearest.distanceM} m) ${nearest.candidate.placeId}`,
  };
}

const BASIS_RANK: Record<MatchBasis, number> = {
  name: 0,
  area: 1,
  translation: 2,
};

/**
 * For the reason only: a hit that is an address — a street-level one, or a
 * road / postcode whose name did not match.
 */
function isAddressLike(candidate: PlaceCandidate): boolean {
  return (
    isStreetLevel(candidate) ||
    (candidate.types.length > 0 &&
      candidate.types.every((t) => STREET_TYPES.has(t) || t === "route"))
  );
}

// The language a place's own name is in, from its address — so a re-search
// asks Google for "Musée Bourdelle", not "Bourdelle Museum". A closed table:
// an address it cannot place gets no re-search. Order matters: countries and
// cities first, the bare 5-digit postcode (France) last.
const LANGUAGE_BY_ADDRESS: readonly [RegExp, string][] = [
  [
    /\b(deutschland|germany|allemagne|berlin|hamburg|hambourg|munchen|osterreich|austria|autriche)\b/,
    "de",
  ],
  [/\b(danmark|denmark|danemark|kobenhavn|copenhagen)\b/, "da"],
  [/\b(italia|italy|italie)\b/, "it"],
  [/\b(iceland|islande|island)\b/, "is"],
  [/\b(nederland|netherlands|pays bas|amsterdam)\b/, "nl"],
  [/\b(espana|spain|espagne|mexico|mexique)\b/, "es"],
  [/\b(portugal)\b/, "pt"],
  [/\b(france|paris|lyon)\b/, "fr"],
  [/\b\d{5}\b/, "fr"],
];

/** The language to re-search a place in, or undefined when its address is not in the table. */
export function languageForAddress(address: string): string | undefined {
  const text = rawTokens(address).join(" ");
  return LANGUAGE_BY_ADDRESS.find(([pattern]) => pattern.test(text))?.[1];
}
