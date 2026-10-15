import { z } from "zod";

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
