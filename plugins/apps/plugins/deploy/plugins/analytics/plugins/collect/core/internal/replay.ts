import { z } from "zod";
import { PagePathSchema } from "./collect-body";
import { SectionNameSchema } from "./page-sections";

/**
 * The session replay's channel: the deploy app's Sessions tab plays a recorded
 * visit in a frame of the site's LOCAL serve, and drives it over
 * `postMessage` — go to a page in-app (as the visitor did, without a reload),
 * scroll a section into view (as the visitor's `section_reach` says they did).
 *
 * Only a page served on this computer's gateway ever listens
 * (`web/internal/replay-follow.ts`): a deployed site on its public host
 * never installs the listener, so nothing on the internet can drive it.
 *
 * Every message carries {@link REPLAY_PROTOCOL}; anything else is ignored.
 */
export const REPLAY_PROTOCOL = "equin.session-replay/1";

/** What the replay asks the framed site to do. */
export const ReplayCommandSchema = z.discriminatedUnion("kind", [
  /** Go to `path` the way the visitor's in-app navigation did: no reload. */
  z
    .object({
      protocol: z.literal(REPLAY_PROTOCOL),
      kind: z.literal("navigate"),
      path: PagePathSchema,
    })
    .strict(),
  /** Scroll the current page's section `section` (`<page>/<key>`, as its reach hit names it) into view. */
  z
    .object({
      protocol: z.literal(REPLAY_PROTOCOL),
      kind: z.literal("scroll-to"),
      section: SectionNameSchema,
    })
    .strict(),
  /** Scroll back to the top: a page's start. */
  z
    .object({
      protocol: z.literal(REPLAY_PROTOCOL),
      kind: z.literal("scroll-top"),
    })
    .strict(),
]);
export type ReplayCommand = z.infer<typeof ReplayCommandSchema>;

/**
 * What the framed site tells the replay: it is up and listening — sent once,
 * when its tracker starts (the app rendered its first route), so the replay
 * knows when the page load it is replaying is over on this computer too.
 */
export const ReplayFrameMessageSchema = z
  .object({
    protocol: z.literal(REPLAY_PROTOCOL),
    kind: z.literal("ready"),
  })
  .strict();
export type ReplayFrameMessage = z.infer<typeof ReplayFrameMessageSchema>;
