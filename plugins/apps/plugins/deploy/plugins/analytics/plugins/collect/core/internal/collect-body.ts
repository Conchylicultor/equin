import { z } from "zod";

/**
 * What the tracker sends to `POST /api/analytics/collect`, and the limits the
 * server enforces on it. The server reads the visitor's IP, user agent and
 * `Accept-Language` from the request itself — they are never in the body.
 */

/** Requests whose declared `Content-Length` exceeds this are refused (413). */
export const MAX_COLLECT_BODY_BYTES = 4096;
/** A path longer than this (after the query string is removed) is refused. */
export const MAX_PATH_LENGTH = 512;
export const MAX_HOST_LENGTH = 253;
export const MAX_REFERRER_LENGTH = 2048;
export const MAX_UTM_LENGTH = 128;
export const EVENT_NAME_PATTERN = /^[a-z0-9_]{1,64}$/;
/**
 * A prop key: the same alphabet as an event name, so an `event_prop` value
 * (`<event>.<key>=<value>`, see `event-prop.ts`) splits back unambiguously.
 */
export const EVENT_PROP_KEY_PATTERN = /^[a-z0-9_]{1,64}$/;
export const MAX_EVENT_PROPS = 10;
export const MAX_EVENT_PROP_VALUE_LENGTH = 128;
/** One pageview's visible time is capped at a day; anything above is a stuck tab. */
export const MAX_ENGAGED_MS = 24 * 60 * 60 * 1000;

/**
 * A page path with its query string and fragment removed. The tracker strips
 * them before sending; the schema strips them again, so a query string never
 * reaches storage whatever the client does.
 */
export function stripQuery(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

export const PagePathSchema = z
  .string()
  .max(MAX_REFERRER_LENGTH)
  .transform(stripQuery)
  .pipe(z.string().min(1).max(MAX_PATH_LENGTH).startsWith("/"));

/** `location.host` of the page (hostname plus any port). */
export const SiteHostSchema = z
  .string()
  .min(1)
  .max(MAX_HOST_LENGTH)
  .regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/)
  .transform((host) => host.toLowerCase());

const UtmValueSchema = z.string().trim().min(1).max(MAX_UTM_LENGTH);

export const UtmTagsSchema = z
  .object({
    source: UtmValueSchema.optional(),
    medium: UtmValueSchema.optional(),
    campaign: UtmValueSchema.optional(),
  })
  .strict();

export const EventPropsSchema = z
  .record(
    z.string().regex(EVENT_PROP_KEY_PATTERN),
    z.string().max(MAX_EVENT_PROP_VALUE_LENGTH),
  )
  .refine((props) => Object.keys(props).length <= MAX_EVENT_PROPS, {
    message: `at most ${MAX_EVENT_PROPS} event props`,
  });

export const PageviewBodySchema = z
  .object({
    kind: z.literal("pageview"),
    host: SiteHostSchema,
    path: PagePathSchema,
    /**
     * `document.referrer`, sent with the FIRST pageview of a page load only.
     * The server keeps its host and path (no query string) and drops a
     * self-referral.
     */
    referrer: z.string().max(MAX_REFERRER_LENGTH).optional(),
    /** `utm_*` tags on the landing URL, first pageview only. */
    utm: UtmTagsSchema.optional(),
  })
  .strict();

export const EventBodySchema = z
  .object({
    kind: z.literal("event"),
    host: SiteHostSchema,
    path: PagePathSchema,
    name: z.string().regex(EVENT_NAME_PATTERN),
    props: EventPropsSchema.optional(),
  })
  .strict();

export const EngagementBodySchema = z
  .object({
    kind: z.literal("engagement"),
    /** The `pageviewId` the pageview's response returned. */
    pageviewId: z.string().uuid(),
    /**
     * CUMULATIVE visible milliseconds of that pageview so far — send it on
     * every `visibilitychange → hidden` / `pagehide`; the server keeps the max,
     * so repeats never double count.
     */
    engagedMs: z.number().int().min(0).max(MAX_ENGAGED_MS),
  })
  .strict();

export const CollectBodySchema = z.discriminatedUnion("kind", [
  PageviewBodySchema,
  EventBodySchema,
  EngagementBodySchema,
]);
export type CollectBody = z.infer<typeof CollectBodySchema>;
export type PageviewBody = z.infer<typeof PageviewBodySchema>;
export type EventBody = z.infer<typeof EventBodySchema>;
export type EngagementBody = z.infer<typeof EngagementBodySchema>;

/**
 * What the server did with one collect request.
 *
 * - `pageview` — recorded; `pageviewId` is what later `engagement` beacons for
 *   this page reference.
 * - `event` / `engagement` — recorded.
 * - `ignored` — deliberately not recorded: the user agent is a bot, or the
 *   engagement names a pageview that does not exist (swept, or never recorded
 *   because it was a bot).
 */
export const CollectResponseSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("pageview"), pageviewId: z.string().uuid() }),
  z.object({ outcome: z.literal("event") }),
  z.object({ outcome: z.literal("engagement") }),
  z.object({
    outcome: z.literal("ignored"),
    reason: z.enum(["bot", "unknown-pageview"]),
  }),
]);
export type CollectResponse = z.infer<typeof CollectResponseSchema>;
