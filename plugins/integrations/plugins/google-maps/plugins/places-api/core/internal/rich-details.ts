import { z } from "zod";
import { skuFor, type PlacesSku } from "./sku";

/**
 * What a photo is called in the Places API: `places/<placeId>/photos/<ref>`.
 * A server that fetches a photo's bytes by name accepts only this shape, so a
 * caller cannot steer the keyed request at any other Google path.
 */
export const PHOTO_NAME_PATTERN = /^places\/[^/]+\/photos\/[^/]+$/;

/** One moment of a weekly schedule, in the PLACE's own clock: day 0 = Sunday. */
const OpeningPointSchema = z.object({
  day: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

export type OpeningPoint = z.infer<typeof OpeningPointSchema>;

/**
 * A place's regular week, as Google gives it. `periods` drive "open now"; a
 * period without `close` is the one Google uses for a place open around the
 * clock. `weekdayDescriptions` are Google's own formatted lines, Monday first
 * ("Monday: 9:00 AM – 6:30 PM").
 */
export const OpeningHoursSchema = z.object({
  periods: z.array(
    z.object({
      open: OpeningPointSchema,
      close: OpeningPointSchema.optional(),
    }),
  ),
  weekdayDescriptions: z.array(z.string()),
});

export type OpeningHours = z.infer<typeof OpeningHoursSchema>;

export const PlacePhotoSchema = z.object({
  /** Its `PHOTO_NAME_PATTERN` name; the bytes are fetched by it. Names expire. */
  name: z.string().regex(PHOTO_NAME_PATTERN),
  widthPx: z.number(),
  heightPx: z.number(),
  /** Who took it — Google's terms require showing it with the photo. */
  authors: z.array(z.object({ name: z.string(), uri: z.string().optional() })),
});

export type PlacePhoto = z.infer<typeof PlacePhotoSchema>;

/**
 * The richer half of a place's Google details — the Enterprise-priced fields a
 * place card shows but nothing stores (Google's terms forbid caching them
 * beyond short-term use). Every field is optional: Google omits what it does
 * not know, and a park has no phone.
 */
export const PlaceRichDetailsSchema = z.object({
  photos: z.array(PlacePhotoSchema),
  hours: OpeningHoursSchema.optional(),
  /** The place's offset from UTC now, in minutes — its clock for `hours`. */
  utcOffsetMinutes: z.number().optional(),
  rating: z.number().optional(),
  ratingCount: z.number().optional(),
  /** 0 (free) … 4 (very expensive). */
  priceLevel: z.number().int().min(0).max(4).optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  /** Google's one-line description of the place. */
  summary: z.string().optional(),
});

export type PlaceRichDetails = z.infer<typeof PlaceRichDetailsSchema>;

/**
 * How much of a place's rich details a card asks for, richest first — the
 * steps of its downgrade ladder (`place-details`), each a Place Details SKU of
 * its own (`richDetailsSku`):
 *
 * - `full` — everything below plus Google's summary: **Enterprise +
 *   Atmosphere** (`editorialSummary`), the most expensive Place Details SKU.
 * - `no-summary` — photos, the regular week (and the UTC offset to read it
 *   in), rating and its count, price level, phone, website: **Enterprise**.
 * - `photos` — the photo names alone: **IDs Only**, free. Only the Place Photo
 *   call that fetches a photo's bytes is billed.
 *
 * Each is its own call, made only when a card opens and cached by the caller
 * for a day — never folded into the snapshot mask save and the monthly refresh
 * pay for. Re-check Google's SKU table before relying on these tiers.
 */
export const RICH_DETAILS_TIERS = ["full", "no-summary", "photos"] as const;
export type RichDetailsTier = (typeof RICH_DETAILS_TIERS)[number];

const NO_SUMMARY_FIELDS = [
  "id",
  "photos",
  "regularOpeningHours",
  "utcOffsetMinutes",
  "rating",
  "userRatingCount",
  "priceLevel",
  "internationalPhoneNumber",
  "websiteUri",
];

/** The Place Details field mask of each tier. */
export const RICH_DETAILS_MASKS: Record<RichDetailsTier, string> = {
  full: [...NO_SUMMARY_FIELDS, "editorialSummary"].join(","),
  "no-summary": NO_SUMMARY_FIELDS.join(","),
  photos: ["id", "photos"].join(","),
};

/** What one call of a tier is billed as — derived from its mask. */
export function richDetailsSku(tier: RichDetailsTier): PlacesSku {
  return skuFor("place-details", RICH_DETAILS_MASKS[tier]);
}
