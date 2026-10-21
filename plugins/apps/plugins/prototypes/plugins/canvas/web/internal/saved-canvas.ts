import { z } from "zod";
import {
  PrototypeVersionSchema,
  SIZE_PRESETS,
  StoredPicksSchema,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import { settleLayout, type CanvasState } from "./canvas-model";

/**
 * The canvas as this browser saved it, one entry per prototype — so reloading
 * the pane (or coming back to the prototype later) reopens the frames, their
 * versions and picks, the size, zoom and layout as they were left.
 *
 * Frame A's picks are NOT in here: A holds `"shared"`, a pointer to the
 * prototype's one shared record on the server, which stays the only truth for
 * them. Everything else is this browser's own view of the prototype.
 */

const PRESET_NAMES = SIZE_PRESETS.map((p) => p.name) as [
  (typeof SIZE_PRESETS)[number]["name"],
  ...(typeof SIZE_PRESETS)[number]["name"][],
];

const FrameIdSchema = z.number().int().positive();

export const SavedCanvasSchema = z.object({
  frames: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          id: FrameIdSchema,
          kind: z.literal("prototype"),
          version: PrototypeVersionSchema.nullable(),
          picks: z.union([z.literal("shared"), StoredPicksSchema]),
        }),
        z.object({
          id: FrameIdSchema,
          kind: z.literal("source"),
          source: z.string().min(1),
        }),
      ]),
    )
    .min(1),
  nextId: FrameIdSchema,
  selected: FrameIdSchema,
  size: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("responsive") }),
    z.object({ kind: z.literal("window") }),
    z.object({ kind: z.literal("preset"), preset: z.enum(PRESET_NAMES) }),
    z.object({
      kind: z.literal("custom"),
      w: z.number().positive(),
      h: z.number().positive(),
    }),
  ]),
  zoom: z.union([z.literal("fit"), z.number().min(0.1).max(2)]),
  wholePage: z.boolean(),
  layout: z.enum(["side", "swipe"]),
  swipeAt: z.number().min(0).max(1),
  spread: z.string().nullable(),
  linked: z.array(z.string()),
});

type SavedCanvas = z.infer<typeof SavedCanvasSchema>;

/**
 * The canvas as it is written to storage (`linked` is a Set in memory). A
 * drag's `preview` is never saved: it is what is on screen for a moment, and a
 * reopened canvas shows the picks.
 */
export function serializeCanvas(state: CanvasState): SavedCanvas {
  return {
    frames: [...state.frames],
    nextId: state.nextId,
    selected: state.selected,
    size: state.size,
    zoom: state.zoom,
    wholePage: state.wholePage,
    layout: state.layout,
    swipeAt: state.swipeAt,
    spread: state.spread,
    linked: [...state.linked],
  };
}

/**
 * What a saved canvas reopens as: `restored`, or `rejected` with why — a value
 * written by an older shape of the canvas, or one that breaks a rule the
 * reducer keeps (exactly one frame holds the shared picks and it is the first
 * prototype frame; ids are unique and below `nextId`; the selection is on the
 * canvas). A Swipe layout without exactly two frames is settled, not rejected.
 */
export type RestoredCanvas =
  | { kind: "restored"; state: CanvasState }
  | { kind: "rejected"; reason: string };

export function restoreCanvas(raw: unknown): RestoredCanvas {
  const parsed = SavedCanvasSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "rejected", reason: parsed.error.message };
  }
  const saved = parsed.data;
  const ids = saved.frames.map((f) => f.id);
  if (new Set(ids).size !== ids.length) {
    return { kind: "rejected", reason: "two frames share an id" };
  }
  if (ids.some((id) => id >= saved.nextId)) {
    return { kind: "rejected", reason: "a frame id is not below nextId" };
  }
  if (!ids.includes(saved.selected)) {
    return {
      kind: "rejected",
      reason: "the selected frame is not on the canvas",
    };
  }
  const protos = saved.frames.filter((f) => f.kind === "prototype");
  const sharedAt = protos.flatMap((f, i) => (f.picks === "shared" ? [i] : []));
  if (protos.length > 0 && (sharedAt.length !== 1 || sharedAt[0] !== 0)) {
    return {
      kind: "rejected",
      reason: "the shared picks are not held by frame A alone",
    };
  }
  return {
    kind: "restored",
    // A swipe canvas of one or three frames was written before the reducer
    // settled the layout: it reopens side by side, as it was drawn.
    state: settleLayout({
      ...saved,
      linked: new Set(saved.linked),
      preview: null,
    }),
  };
}
