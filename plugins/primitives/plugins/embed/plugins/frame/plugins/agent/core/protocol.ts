import { z } from "zod";

/**
 * The parent ↔ content-frame channel: a closed request/response protocol over
 * a `MessagePort` the parent hands the frame's agent on `load`
 * (`frame-agent.ts`). It replaces every `contentDocument` read the app used to
 * make into a same-origin frame — content now lives on another origin, so the
 * only way in is to ask.
 *
 * **Every answer is untrusted data.** The agent shares a realm with the
 * content it serves: the content can grab the port and answer in its place.
 * So replies are parsed here, numbers are bounded, and nothing a reply says
 * may do more than lay a frame out.
 */
export const FRAME_PROTOCOL = "equin-frame/1";

/** The window message the parent posts with the port (`ports[0]`). */
export const FrameConnectSchema = z.object({
  protocol: z.literal(FRAME_PROTOCOL),
  type: z.literal("connect"),
});

/** A scroll offset in a content document, found again by id or DOM path. */
export const ScrollPlaceSchema = z.object({
  locator: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("root") }),
    z.object({ kind: z.literal("id"), id: z.string().max(512) }),
    z.object({
      kind: z.literal("path"),
      path: z.array(z.number().int().min(0).max(100_000)).max(256),
    }),
  ]),
  top: z.number().finite(),
  left: z.number().finite(),
});
export type ScrollPlace = z.infer<typeof ScrollPlaceSchema>;

/** Every scroll offset of a document that is not at the origin. */
export const DocumentScrollSchema = z.array(ScrollPlaceSchema).max(512);
export type DocumentScroll = z.infer<typeof DocumentScrollSchema>;

/** What the parent asks. `id` pairs a request with its reply. */
export type FrameRequest =
  /** Set `--<name>` custom properties on `<html>` ("" removes one). */
  | { op: "setVars"; vars: Readonly<Record<string, string>> }
  /** Set `--prototype-screen-height`; fires `resize` when it changed. */
  | { op: "setScreenHeight"; px: number }
  /** Fire `resize` on the document's window. */
  | { op: "dispatchResize" }
  /** Resolve after the document's scripts had a few frames to react. */
  | { op: "settle" }
  /** The document's heights, read now. */
  | { op: "measure" }
  /** Report the content height (`height` events) as it changes. */
  | { op: "watchHeight" }
  | { op: "unwatchHeight" }
  /** Every non-zero scroll offset. */
  | { op: "captureScroll" }
  /** Scroll to these offsets, retrying while the document grows (≤ 5 s). */
  | { op: "restoreScroll"; scroll: DocumentScroll }
  | { op: "cancelRestore" };

export type FrameOp = FrameRequest["op"];

const px = z.number().finite().min(0).max(1_000_000);

/** A document's heights, as `measure` and `height` events report them. */
export const FrameHeightsSchema = z.object({
  /** `documentElement.scrollHeight`: at least the frame's height. */
  scrollHeight: px,
  /** How far the content reaches, the frame's own height not counted. */
  contentHeight: px,
  /** The frame's viewport height as the document sees it. */
  innerHeight: px,
});
export type FrameHeights = z.infer<typeof FrameHeightsSchema>;

/** The value each op's reply carries. */
export const FRAME_REPLY_VALUES = {
  setVars: z.null(),
  setScreenHeight: z.null(),
  dispatchResize: z.null(),
  settle: z.null(),
  measure: FrameHeightsSchema,
  watchHeight: z.null(),
  unwatchHeight: z.null(),
  captureScroll: DocumentScrollSchema,
  restoreScroll: z.null(),
  cancelRestore: z.null(),
} as const satisfies Record<FrameOp, z.ZodType>;

export type FrameReplyValue<Op extends FrameOp> = z.infer<
  (typeof FRAME_REPLY_VALUES)[Op]
>;

/** A message from the frame: a reply to one request, or an event. */
export const FrameMessageSchema = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), value: z.unknown() }),
  z.object({
    id: z.number().int(),
    ok: z.literal(false),
    error: z.string().max(2000),
  }),
  z.object({ event: z.literal("height"), heights: FrameHeightsSchema }),
  z.object({ event: z.literal("activity") }),
]);
export type FrameMessage = z.infer<typeof FrameMessageSchema>;
