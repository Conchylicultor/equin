import { z } from "zod";

/**
 * The page's viewport when a pageview was recorded: the layout viewport's CSS
 * pixels (`innerWidth` × `innerHeight`), what the visitor's screen showed of
 * the site — the size the Sessions tab's replay plays the visit at. Sent with
 * every pageview (a window resized, a phone turned, between two pages reads
 * on the next one). Absent from an older tracker: the hit's `viewport` is then
 * NULL, never a made-up size.
 */

/** A side past this is not a screen: refused. */
export const MAX_VIEWPORT_PX = 16_384;

const SidePx = z.number().int().positive().max(MAX_VIEWPORT_PX);

export const ViewportSchema = z.object({ w: SidePx, h: SidePx }).strict();
export type Viewport = z.infer<typeof ViewportSchema>;
