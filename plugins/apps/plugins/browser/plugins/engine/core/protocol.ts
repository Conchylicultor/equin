import { z } from "zod";

/**
 * The wire of one streamed browser tab: the Browser app's viewport ⇄ the
 * backend relay ⇄ the engine host (`bin/host.ts`). The relay passes frames
 * through untouched, so this one schema is spoken end to end.
 *
 * One socket per VIEWED tab: the first client message is `attach`; binary
 * host messages are JPEG screencast frames, text ones are `HostEvent`s. Binary
 * client messages are the bytes of an upload a `files` message announced, and
 * nothing else.
 */
export const ENGINE_WS_PATH = "/ws/browser/engine";

/** Bump on any change below; the relay refuses a host speaking another one. */
export const ENGINE_PROTOCOL = 2;

/** Most bytes one binary client message (an upload chunk) carries. */
export const UPLOAD_CHUNK_BYTES = 256 * 1024;

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
const Modifiers = z.number().int().min(0).max(15);

const Viewport = z.object({
  /** CSS pixels. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Device pixel ratio the frames are rendered at (capped by the host). */
  dpr: z.number().positive(),
});
export type EngineViewport = z.infer<typeof Viewport>;

export const ClientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("attach"),
    /** Stable remote-page key the app tab owns (a UUID). */
    key: z.string().min(1),
    /** Opened when the host has no page for `key` (a fresh or expired tab). */
    url: z.string(),
    viewport: Viewport,
  }),
  z.object({ t: z.literal("navigate"), url: z.string() }),
  z.object({ t: z.literal("back") }),
  z.object({ t: z.literal("forward") }),
  z.object({ t: z.literal("reload") }),
  z.object({ t: z.literal("stop") }),
  z.object({ t: z.literal("resize"), viewport: Viewport }),
  z.object({
    t: z.literal("mouse"),
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved"]),
    /** CSS pixels relative to the viewport. */
    x: z.number(),
    y: z.number(),
    button: z.enum(["none", "left", "middle", "right", "back", "forward"]),
    /** Pressed-buttons bitmask (DOM `MouseEvent.buttons`). */
    buttons: z.number().int().min(0),
    /** DOM `MouseEvent.detail`: 2 = double, 3 = triple click. */
    clickCount: z.number().int().min(0),
    modifiers: Modifiers,
  }),
  z.object({
    t: z.literal("wheel"),
    x: z.number(),
    y: z.number(),
    deltaX: z.number(),
    deltaY: z.number(),
    modifiers: Modifiers,
  }),
  z.object({
    t: z.literal("key"),
    type: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    key: z.string(),
    code: z.string(),
    keyCode: z.number().int(),
    /** Text the key inserts ("" for none). */
    text: z.string(),
    modifiers: Modifiers,
    /** macOS editing commands (`selectAll`, `undo`, …) the key triggers. */
    commands: z.array(z.string()).optional(),
  }),
  z.object({ t: z.literal("insertText"), text: z.string() }),
  z.object({
    t: z.literal("ime"),
    text: z.string(),
    selectionStart: z.number().int(),
    selectionEnd: z.number().int(),
  }),
  /** Read the page's current selection; answered by `copied`. */
  z.object({ t: z.literal("copy") }),
  z.object({
    t: z.literal("dialog"),
    accept: z.boolean(),
    promptText: z.string().optional(),
  }),
  /** The option picked in the `select` menu the host reported last. */
  z.object({ t: z.literal("select"), value: z.string().nullable() }),
  /**
   * The answer to the pending `fileChooser`: the files picked (`[]` = cancel),
   * whose bytes follow in this order as binary messages of at most
   * {@link UPLOAD_CHUNK_BYTES}, each acked by an `upload` event.
   */
  z.object({
    t: z.literal("files"),
    files: z
      .array(
        z.object({
          name: z.string().min(1),
          type: z.string(),
          size: z.number().int().min(0),
        }),
      )
      .max(100),
  }),
  /** Close the remote page (the app tab was closed). */
  z.object({ t: z.literal("close") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const PageStateSchema = z.object({
  url: z.string(),
  title: z.string(),
  faviconUrl: z.string().nullable(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});
export type PageState = z.infer<typeof PageStateSchema>;

export const HostEventSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("state"), state: PageStateSchema }),
  /** CSS `cursor` value under the pointer. */
  z.object({ t: z.literal("cursor"), value: z.string() }),
  z.object({ t: z.literal("copied"), text: z.string() }),
  z.object({
    t: z.literal("dialog"),
    type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
    message: z.string(),
    defaultValue: z.string(),
  }),
  z.object({
    t: z.literal("select"),
    options: z.array(
      z.object({
        value: z.string(),
        label: z.string(),
        disabled: z.boolean(),
        selected: z.boolean(),
      }),
    ),
    /** The `<select>`'s box, CSS pixels relative to the viewport. */
    rect: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }),
  }),
  /** The page opened another (window.open, target=_blank): open an app tab on `key`. */
  z.object({ t: z.literal("popup"), key: z.string(), url: z.string() }),
  z.object({ t: z.literal("download"), name: z.string(), path: z.string() }),
  z.object({ t: z.literal("error"), message: z.string() }),
  /**
   * The page asks for files (`<input type=file>`): answer with `files`. Its
   * `accept` attribute, verbatim (`""` = any).
   */
  z.object({
    t: z.literal("fileChooser"),
    multiple: z.boolean(),
    accept: z.string(),
  }),
  /**
   * Upload progress, one per chunk the host wrote (the client's flow control):
   * `received === total` = the page has the files.
   */
  z.object({
    t: z.literal("upload"),
    received: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
  /**
   * Another socket attached to this page (another window shows the tab): this
   * one is closed right after, and does not reconnect on its own.
   */
  z.object({ t: z.literal("displaced") }),
]);
export type HostEvent = z.infer<typeof HostEventSchema>;
