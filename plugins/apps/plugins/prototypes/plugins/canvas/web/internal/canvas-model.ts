import {
  pickedValue,
  type PrototypeOption,
  type PrototypeVersion,
  type PrototypeViewport,
  type StoredPicks,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";

/**
 * The canvas of one prototype's detail pane, as data: which frames sit on it,
 * which one is selected, and the canvas-wide size, zoom and layout.
 *
 * Everything here is pure. {@link canvasReducer} is the only way the state
 * changes, and anything it cannot do itself — writing the prototype's ONE
 * shared picks record, which lives on the server — it hands back as an
 * {@link CanvasEffect} for the provider to run. So every rule of the canvas
 * (frame A, linked options, spread, keep-only) is unit-tested here without a
 * DOM or a server.
 */

export type FrameId = number;

/**
 * A frame showing the prototype itself: one recorded version (`null` for the
 * live folder) under one set of option picks.
 *
 * `picks: "shared"` reads and writes the prototype's one shared record — the
 * picks every tab, deploy and agent CLI sees. Exactly one frame holds it:
 * **frame A**, the first prototype frame. Every other prototype frame holds
 * picks of its own, local to this pane.
 */
export interface PrototypeFrame {
  id: FrameId;
  kind: "prototype";
  version: PrototypeVersion | null;
  picks: "shared" | StoredPicks;
}

/** A frame showing something else: one `FrameSource` contribution, by its id. */
export interface SourceFrame {
  id: FrameId;
  kind: "source";
  source: string;
}

export type CanvasFrame = PrototypeFrame | SourceFrame;

/**
 * The logical size every frame renders at: any size a prototype can declare —
 * the space the canvas has (`responsive` — the page's own responsive layout
 * shows), the viewer's own browser window (`window`), or a device preset (`SIZE_PRESETS`: the device's SCREEN; a page longer
 * than it scrolls inside the frame unless Whole page is on) — or a width
 * dragged off the presets (`custom`).
 */
export type CanvasSize =
  PrototypeViewport | { kind: "custom"; w: number; h: number };

/** Fit (the whole frame visible at once) or a fixed scale, 0.1–2. */
export type CanvasZoom = "fit" | number;

/** Frames side by side, or — with exactly two — one swiped over the other. */
export type CanvasLayout = "side" | "swipe";

export interface CanvasState {
  frames: readonly CanvasFrame[];
  /** The id the next frame added gets. Ids are never reused within a canvas. */
  nextId: FrameId;
  /** The frame keyboard shortcuts act on; always one of `frames`. */
  selected: FrameId;
  size: CanvasSize;
  zoom: CanvasZoom;
  /** Show each page's entire content rather than one screen of it. */
  wholePage: boolean;
  layout: CanvasLayout;
  /** Where the swipe divider sits, 0 (all B) to 1 (all A). */
  swipeAt: number;
  /** The option the prototype frames are spread over (one frame per value). */
  spread: string | null;
  /** Options kept the same in every prototype frame. */
  linked: ReadonlySet<string>;
  /**
   * A color being dragged, shown before it is picked: frame `id` (and every
   * frame, when the option is linked) paints `value` for `option` instead of
   * its pick. Local and never saved — `setPick` commits it (one write) and
   * clears it. See {@link previewedValue}.
   */
  preview: CanvasPreview | null;
}

/** A color option's not-yet-picked value, while the reader drags it. */
export interface CanvasPreview {
  id: FrameId;
  option: string;
  /** A suggestion's name or `#rrggbb` — a pick value of the option. */
  value: string;
}

/** The server-side writes a transition asks for, against the shared record. */
export type CanvasEffect =
  | { kind: "setShared"; option: string; value: string }
  | { kind: "resetShared" }
  /** Make the shared record exactly `picks` (a frame became A). */
  | { kind: "replaceShared"; picks: StoredPicks };

export type CanvasAction =
  /**
   * Add a prototype frame: a copy of `from` (or of the last prototype frame),
   * showing `version` instead of the copied one when given (`null` = live).
   */
  | {
      type: "addPrototype";
      from?: FrameId;
      version?: PrototypeVersion | null;
    }
  | { type: "addSource"; source: string }
  | { type: "remove"; id: FrameId }
  /** Close every frame but `id` (the provider keeps the state before, for Undo). */
  | { type: "keepOnly"; id: FrameId }
  /** Undo: put back `state`, and the shared record as it was then. */
  | { type: "restore"; state: CanvasState; shared: StoredPicks }
  | { type: "select"; id: FrameId }
  | { type: "setVersion"; id: FrameId; version: PrototypeVersion | null }
  | { type: "setPick"; id: FrameId; option: string; value: string }
  /**
   * Show `value` for a color option on frame `id` (and its linked frames)
   * without picking it — every move of a drag. Local: no effect, never saved.
   */
  | { type: "previewPick"; id: FrameId; option: string; value: string }
  /** Drop the preview without picking anything. */
  | { type: "clearPreview" }
  | { type: "resetPicks"; id: FrameId }
  /** Link or unlink `option`; linking copies frame `id`'s value everywhere. */
  | { type: "toggleLink"; id: FrameId; option: PrototypeOption }
  /** Spread over `option` from frame `id` — or, when already spread, gather back to it. */
  | { type: "toggleSpread"; id: FrameId; option: PrototypeOption }
  | { type: "setSize"; size: CanvasSize }
  | { type: "setZoom"; zoom: CanvasZoom }
  | { type: "setWholePage"; on: boolean }
  | { type: "setLayout"; layout: CanvasLayout }
  | { type: "setSwipeAt"; at: number };

export interface CanvasTransition {
  state: CanvasState;
  effects: CanvasEffect[];
}

/**
 * How a canvas opens: frame A, and optionally a frame source beside it, at
 * `size` — the size the prototype declares it is designed at.
 */
export function initialCanvasState({
  size,
  version = null,
  picks = "shared",
  source,
}: {
  size: PrototypeViewport;
  version?: PrototypeVersion | null;
  /** Frame A's picks — `"shared"` except on a page that names its own. */
  picks?: "shared" | StoredPicks;
  source?: string;
}): CanvasState {
  const frames: CanvasFrame[] = [{ id: 1, kind: "prototype", version, picks }];
  if (source !== undefined) frames.push({ id: 2, kind: "source", source });
  return {
    frames,
    nextId: frames.length + 1,
    selected: 1,
    size,
    zoom: "fit",
    wholePage: false,
    layout: "side",
    swipeAt: 0.5,
    spread: null,
    linked: new Set(),
    preview: null,
  };
}

/**
 * Whether `action` changes only what is on screen right now — nothing worth
 * saving with the canvas (a drag's preview).
 */
export function isTransientAction(action: CanvasAction): boolean {
  return action.type === "previewPick" || action.type === "clearPreview";
}

/**
 * The value the preview shows for `option` on frame `id`, or `null` when it
 * shows none there: the frame being dragged on, or any prototype frame when the
 * option is linked (a linked pick goes to every frame, so its preview does).
 */
export function previewedValue(
  state: CanvasState,
  id: FrameId,
  option: string,
): string | null {
  const p = state.preview;
  if (p === null || p.option !== option) return null;
  return p.id === id || state.linked.has(option) ? p.value : null;
}

/**
 * The values spreading over `option` lays out, one frame each: a choice's
 * values, a color's suggestions — and the spread-from frame's own value first
 * when it is not among them (a custom color), so that frame keeps its place.
 */
export function spreadValues(
  option: PrototypeOption,
  baseValue: string,
): readonly string[] {
  const values =
    option.kind === "choice"
      ? option.values
      : option.suggestions.map((s) => s.name);
  return values.includes(baseValue) ? values : [baseValue, ...values];
}

/** The prototype frames, in canvas order. */
export function prototypeFrames(
  frames: readonly CanvasFrame[],
): PrototypeFrame[] {
  return frames.filter((f): f is PrototypeFrame => f.kind === "prototype");
}

/** Frame A: the first prototype frame — `null` when only sources remain. */
export function frameA(frames: readonly CanvasFrame[]): PrototypeFrame | null {
  return prototypeFrames(frames)[0] ?? null;
}

/** The picks a frame shows, with `"shared"` read from the shared record. */
export function picksOf(
  frame: PrototypeFrame,
  shared: StoredPicks,
): StoredPicks {
  return frame.picks === "shared" ? shared : frame.picks;
}

/**
 * Apply `action`. `shared` is the shared picks record as this pane knows it —
 * what a `"shared"` frame shows, so a copy of it can be taken.
 */
export function canvasReducer(
  state: CanvasState,
  action: CanvasAction,
  shared: StoredPicks,
): CanvasTransition {
  const next = transition(state, action, shared);
  const settled = settlePreview(settleLayout(next.state));
  return settled === next.state ? next : { ...next, state: settled };
}

/** A preview lives only on a frame still on the canvas. */
function settlePreview(state: CanvasState): CanvasState {
  return state.preview !== null && !has(state, state.preview.id)
    ? { ...state, preview: null }
    : state;
}

/**
 * Swipe exists only with exactly two frames. Every rule-keeping transition
 * ends here, so adding or closing a frame while swiping drops back to side by
 * side — never a `swipe` canvas of one or three frames, which the canvas would
 * draw side by side anyway and a saved copy of could not be told apart from a
 * corrupt one. Also how a saved canvas written before this rule reopens.
 */
export function settleLayout(state: CanvasState): CanvasState {
  return state.layout === "swipe" && state.frames.length !== 2
    ? { ...state, layout: "side" }
    : state;
}

function transition(
  state: CanvasState,
  action: CanvasAction,
  shared: StoredPicks,
): CanvasTransition {
  switch (action.type) {
    case "addPrototype": {
      const protos = prototypeFrames(state.frames);
      const src =
        action.from === undefined
          ? protos.at(-1)
          : protos.find((f) => f.id === action.from);
      const frame: PrototypeFrame = src
        ? {
            id: state.nextId,
            kind: "prototype",
            version:
              action.version === undefined ? src.version : action.version,
            picks: { ...picksOf(src, shared) },
          }
        : // No prototype frame left to copy: the new one IS frame A.
          {
            id: state.nextId,
            kind: "prototype",
            version: action.version ?? null,
            picks: "shared",
          };
      return promoteA(
        {
          ...state,
          frames: [...state.frames, frame],
          nextId: state.nextId + 1,
          selected: frame.id,
          spread: null,
        },
        shared,
      );
    }

    case "addSource": {
      if (
        state.frames.some(
          (f) => f.kind === "source" && f.source === action.source,
        )
      ) {
        return unchanged(state);
      }
      const frame: SourceFrame = {
        id: state.nextId,
        kind: "source",
        source: action.source,
      };
      // A source frame is there to be compared against: swipe over it (kept
      // only when it makes two frames — `settleLayout`), at the size the page
      // really lays out at.
      return unchanged({
        ...state,
        frames: [...state.frames, frame],
        nextId: state.nextId + 1,
        selected: frame.id,
        layout: "swipe",
        size: { kind: "responsive" },
      });
    }

    case "remove": {
      // The canvas never goes empty: the last frame has no Close.
      if (state.frames.length <= 1 || !has(state, action.id)) {
        return unchanged(state);
      }
      const frames = state.frames.filter((f) => f.id !== action.id);
      return promoteA(
        {
          ...state,
          frames,
          selected:
            state.selected === action.id ? frames[0]!.id : state.selected,
          spread: prototypeFrames(frames).length < 2 ? null : state.spread,
        },
        shared,
      );
    }

    case "keepOnly": {
      const frame = state.frames.find((f) => f.id === action.id);
      if (!frame) return unchanged(state);
      return promoteA(
        {
          ...state,
          frames: [frame],
          selected: frame.id,
          spread: null,
          layout: "side",
        },
        shared,
      );
    }

    case "restore": {
      // The shared record belongs to frame A. If the A being put back is not the
      // A on screen now, the record has since been rewritten for another frame:
      // put back what it held then.
      const now = frameA(state.frames);
      const then = frameA(action.state.frames);
      const effects: CanvasEffect[] =
        then !== null && now?.id !== then.id
          ? [{ kind: "replaceShared", picks: action.shared }]
          : [];
      return { state: action.state, effects };
    }

    case "select":
      return has(state, action.id)
        ? unchanged({ ...state, selected: action.id })
        : unchanged(state);

    case "setVersion":
      if (!has(state, action.id)) return unchanged(state);
      return unchanged({
        ...state,
        frames: state.frames.map((f) =>
          f.id === action.id && f.kind === "prototype"
            ? { ...f, version: action.version }
            : f,
        ),
        selected: action.id,
      });

    case "setPick": {
      if (!has(state, action.id)) return unchanged(state);
      const { option, value } = action;
      const targets = state.linked.has(option)
        ? prototypeFrames(state.frames).map((f) => f.id)
        : [action.id];
      const { frames, effects } = setPicks(
        state.frames,
        targets,
        option,
        value,
      );
      return {
        state: {
          ...state,
          frames,
          selected: action.id,
          // A pick breaks the spread: the frames no longer run over that option.
          spread: state.spread === option ? null : state.spread,
          // A pick commits the drag it ends.
          preview: state.preview?.option === option ? null : state.preview,
        },
        effects,
      };
    }

    case "previewPick": {
      if (!has(state, action.id)) return unchanged(state);
      const p = state.preview;
      if (
        p !== null &&
        p.id === action.id &&
        p.option === action.option &&
        p.value === action.value
      ) {
        return unchanged(state);
      }
      return unchanged({
        ...state,
        preview: { id: action.id, option: action.option, value: action.value },
      });
    }

    case "clearPreview":
      return state.preview === null
        ? unchanged(state)
        : unchanged({ ...state, preview: null });

    case "resetPicks": {
      const frame = state.frames.find((f) => f.id === action.id);
      if (!frame || frame.kind !== "prototype") return unchanged(state);
      const preview = state.preview?.id === action.id ? null : state.preview;
      if (frame.picks === "shared") {
        return {
          state: preview === state.preview ? state : { ...state, preview },
          effects: [{ kind: "resetShared" }],
        };
      }
      return unchanged({
        ...state,
        frames: state.frames.map((f) =>
          f.id === action.id ? { ...frame, picks: {} } : f,
        ),
        preview,
      });
    }

    case "toggleLink": {
      const name = action.option.name;
      const linked = new Set(state.linked);
      if (linked.has(name)) {
        linked.delete(name);
        return unchanged({ ...state, linked });
      }
      linked.add(name);
      const source = state.frames.find((f) => f.id === action.id);
      if (!source || source.kind !== "prototype") {
        return unchanged({ ...state, linked });
      }
      // Linking makes every frame agree — on the value of the frame it was
      // linked from.
      const value = pickedValue(action.option, picksOf(source, shared));
      const others = prototypeFrames(state.frames)
        .filter((f) => f.id !== source.id)
        .map((f) => f.id);
      const { frames, effects } = setPicks(state.frames, others, name, value);
      return {
        state: {
          ...state,
          frames,
          linked,
          spread: state.spread === name ? null : state.spread,
        },
        effects,
      };
    }

    case "toggleSpread": {
      const base = state.frames.find((f) => f.id === action.id);
      if (!base || base.kind !== "prototype") return unchanged(state);
      const sources = state.frames.filter((f) => f.kind === "source");
      const name = action.option.name;
      if (state.spread === name) {
        // Gather back: the frame it was toggled from, and the sources.
        return promoteA(
          {
            ...state,
            frames: [base, ...sources],
            selected: base.id,
            spread: null,
            layout: "side",
          },
          shared,
        );
      }
      const basePicks = picksOf(base, shared);
      const baseValue = pickedValue(action.option, basePicks);
      let nextId = state.nextId;
      const values = spreadValues(action.option, baseValue);
      if (values.length < 2) return unchanged(state);
      const spreadFrames = values.map((v): PrototypeFrame => {
        if (v === baseValue) return base;
        return {
          id: nextId++,
          kind: "prototype",
          version: base.version,
          picks: { ...basePicks, [name]: v },
        };
      });
      const linked = new Set(state.linked);
      linked.delete(name);
      return promoteA(
        {
          ...state,
          frames: [...spreadFrames, ...sources],
          nextId,
          selected: base.id,
          spread: name,
          linked,
          layout: "side",
        },
        shared,
      );
    }

    case "setSize":
      return unchanged({ ...state, size: action.size });
    case "setZoom":
      return unchanged({ ...state, zoom: action.zoom });
    case "setWholePage":
      return unchanged({ ...state, wholePage: action.on });
    case "setLayout":
      return unchanged({ ...state, layout: action.layout });
    case "setSwipeAt":
      return unchanged({
        ...state,
        swipeAt: Math.min(1, Math.max(0, action.at)),
      });
  }
}

/** The actions that add a frame — the ones {@link canvasWith} takes. */
export type CanvasAddAction = Extract<
  CanvasAction,
  { type: "addPrototype" | "addSource" }
>;

/**
 * The canvas `action` leads to, computed rather than dispatched — for a
 * surface that opens it on another page (Present's one-frame page → the canvas
 * page). Adding a frame never rewrites the shared record while frame A holds
 * it; a canvas whose first prototype frame holds picks of its own would hand
 * them to the record (`promoteA`), which only a dispatch may do — so that
 * throws.
 */
export function canvasWith(
  state: CanvasState,
  action: CanvasAddAction,
  shared: StoredPicks,
): CanvasState {
  const { state: next, effects } = canvasReducer(state, action, shared);
  if (effects.length > 0) {
    throw new Error(
      `canvasWith(${action.type}) would rewrite the shared picks record: frame A must hold "shared"`,
    );
  }
  return next;
}

function unchanged(state: CanvasState): CanvasTransition {
  return { state, effects: [] };
}

function has(state: CanvasState, id: FrameId): boolean {
  return state.frames.some((f) => f.id === id);
}

/**
 * Set `option = value` on the frames `ids`: in place for a frame holding local
 * picks, as a shared-record write for frame A.
 */
function setPicks(
  frames: readonly CanvasFrame[],
  ids: readonly FrameId[],
  option: string,
  value: string,
): { frames: CanvasFrame[]; effects: CanvasEffect[] } {
  const effects: CanvasEffect[] = [];
  const next = frames.map((f): CanvasFrame => {
    if (f.kind !== "prototype" || !ids.includes(f.id)) return f;
    if (f.picks === "shared") {
      effects.push({ kind: "setShared", option, value });
      return f;
    }
    return { ...f, picks: { ...f.picks, [option]: value } };
  });
  return { frames: next, effects };
}

/**
 * Keep the frame-A invariant: the first prototype frame holds the shared
 * record, and no other frame does. When a frame BECOMES A (the old A was
 * closed, or a spread put another frame first), its own picks are written to
 * the shared record, so what is on screen does not change.
 */
function promoteA(state: CanvasState, shared: StoredPicks): CanvasTransition {
  const a = frameA(state.frames);
  if (a === null) return unchanged(state);
  const effects: CanvasEffect[] = [];
  const frames = state.frames.map((f): CanvasFrame => {
    if (f.kind !== "prototype") return f;
    if (f.id === a.id) {
      if (f.picks === "shared") return f;
      effects.push({ kind: "replaceShared", picks: f.picks });
      return { ...f, picks: "shared" };
    }
    // A frame that was A and no longer is keeps what it showed, as its own.
    return f.picks === "shared" ? { ...f, picks: { ...shared } } : f;
  });
  return { state: { ...state, frames }, effects };
}
