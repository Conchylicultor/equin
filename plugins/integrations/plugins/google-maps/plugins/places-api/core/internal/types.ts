import { z } from "zod";
import { OpeningHoursSchema } from "./rich-details";

/**
 * One row of a place search's dropdown. The neutral, provider-independent shape
 * a place picker renders — deliberately NOT Google's `placePrediction` wire
 * shape, so a second provider (OpenStreetMap) can fill the same contract.
 *
 * Schemas rather than bare interfaces because these values cross an HTTP
 * boundary in the consuming plugin: the endpoint that serves them parses them
 * back on the client.
 */
export const PlaceSuggestionSchema = z.object({
  /** Provider-scoped stable id, passed back to `placeDetails` to resolve it. */
  placeId: z.string(),
  /** The bold first line — usually the business or street name. */
  primary: z.string(),
  /**
   * The muted second line (city, country). OPTIONAL: Google omits
   * `structuredFormat.secondaryText` for some predictions, and an empty string
   * would be a fabricated value dressed up as a real one.
   */
  secondary: z.string().optional(),
});

export type PlaceSuggestion = z.infer<typeof PlaceSuggestionSchema>;

/**
 * A resolved place, as stored in the block. `name` and `address` are required —
 * a snapshot that can name neither is not a place, and the client throws rather
 * than emitting a half-blank card.
 *
 * Everything else is optional because the field mask is a cost decision (see
 * `PLACE_DETAILS_FIELD_MASK`) and a narrower mask must stay expressible without
 * a schema change.
 */
/**
 * Whether a place is still in business, as Google reports it. A closed place
 * stays a place — Google keeps serving its details.
 */
export const BUSINESS_STATUSES = [
  "OPERATIONAL",
  "CLOSED_TEMPORARILY",
  "CLOSED_PERMANENTLY",
] as const;

export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

export const PlaceSnapshotSchema = z.object({
  placeId: z.string(),
  /** Display name — the business name, or the street address for a plain address. */
  name: z.string(),
  /** Full formatted postal address. */
  address: z.string(),
  /** Human-readable primary type ("French restaurant", "Park"). */
  category: z.string().optional(),
  /**
   * Google's machine type for the place (`clothing_store`, `cafe`, `park`, …),
   * and the full list it belongs to (most specific first). Google's own
   * taxonomy — a consumer maps it onto its own vocabulary.
   */
  primaryType: z.string().optional(),
  types: z.array(z.string()).optional(),
  /** Canonical Google Maps link for the place — the card's "Open in Maps". */
  mapsUrl: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  /** Absent when Google gives none (a plain address is no business). */
  businessStatus: z.enum(BUSINESS_STATUSES).optional(),
});

export type PlaceSnapshot = z.infer<typeof PlaceSnapshotSchema>;

const LatLngSchema = z.object({ lat: z.number(), lng: z.number() });

/**
 * One hit of a free-text place search (`searchText`): enough to decide whether
 * it is the place meant — its id, name, position and Google types (a hit whose
 * types are all address-like is an address, not a place) — and, at the `rich`
 * detail, what a result card shows (rating, price, this week's hours). Resolve
 * it with `placeDetails` for the full snapshot.
 */
export const PlaceCandidateSchema = z.object({
  placeId: z.string(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  types: z.array(z.string()),
  /** Full formatted address; absent when Google gives none. */
  address: z.string().optional(),
  businessStatus: z.enum(BUSINESS_STATUSES).optional(),
  /**
   * The box Google frames the place in — a town's or a park's extent, a few
   * metres around a shop. Absent when Google gives none.
   */
  viewport: z.object({ low: LatLngSchema, high: LatLngSchema }).optional(),
  /** Human-readable primary type ("Sichuan restaurant"). */
  category: z.string().optional(),
  primaryType: z.string().optional(),
  /** Rich detail only — absent at `pro`, and when Google knows none. */
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  /** 0 (free) … 4 (very expensive). */
  priceLevel: z.number().int().min(0).max(4).optional(),
  /** This week's hours (Google's `currentOpeningHours`), in the place's clock. */
  hours: OpeningHoursSchema.optional(),
  /** The place's offset from UTC now, in minutes — its clock for `hours`. */
  utcOffsetMinutes: z.number().optional(),
});

export type PlaceCandidate = z.infer<typeof PlaceCandidateSchema>;
