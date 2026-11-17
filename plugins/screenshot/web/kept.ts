import { z } from "zod";
import { defineKept } from "@plugins/primitives/plugins/kept-state/web";

/**
 * What a reload of the editor tab must give back (kept-state). The captured
 * image is never held in the page: the capturing tab uploads it as a staged
 * attachment and records it here, per screenshot id — so the editor, and any
 * reload of it, reads the bytes back from the server.
 *
 * `image` is the attachment as markdown (`![screenshot.png](/api/attachments/<id>)`):
 * the spelling paste-images' draft holds look for, so the staged upload is
 * kept alive on the server exactly as long as this entry lives.
 */
export const screenshotCapture = defineKept({
  owner: "screenshot.capture",
  label: "Captured screenshots",
  tier: "work",
  stamp: "tyygnbn27q",
  cap: "16 KB",
  schema: z.object({ image: z.string() }).nullable(),
});

const point = z.object({ x: z.number(), y: z.number() });
const stroke = z.object({
  color: z.string(),
  width: z.number(),
  points: z.array(point),
});

/**
 * One committed edit, replayed in order over the captured image: strokes
 * baked in, or a crop (in the natural pixels of the image before it).
 */
const edit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("draw"), strokes: z.array(stroke) }),
  z.object({
    kind: z.literal("crop"),
    rect: z.object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    }),
  }),
]);
export type ScreenshotEdit = z.infer<typeof edit>;

/**
 * The editing work on one screenshot: the committed edits (the edited image is
 * derived from them, never held) and the strokes drawn but not applied yet.
 */
export const screenshotEdits = defineKept({
  owner: "screenshot.edits",
  label: "Screenshot edits",
  tier: "work",
  stamp: "ivg1sajdzi",
  cap: "512 KB",
  schema: z.object({ edits: z.array(edit), strokes: z.array(stroke) }),
});

const tools = z.object({
  tool: z.enum(["none", "crop", "draw"]),
  color: z.string(),
  width: z.number(),
});
export type ScreenshotTools = z.infer<typeof tools>;

/** The tool and pen picked in the editor pane: where the user was. */
export const screenshotTools = defineKept({
  owner: "screenshot.tools",
  tier: "view",
  schema: tools,
});
