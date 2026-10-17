import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PROTOTYPE_VIEWPORT,
  type ColorOption,
  type PrototypeOption,
  type PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  canvasReducer,
  frameA,
  initialCanvasState as openCanvas,
  isTransientAction,
  previewedValue,
  prototypeFrames,
  spreadValues,
  type CanvasAction,
  type CanvasState,
  type PrototypeFrame,
} from "./canvas-model";

/** A canvas opened at the default size (the size is not what these pin). */
function initialCanvasState(
  opts: Omit<Parameters<typeof openCanvas>[0], "size"> = {},
): CanvasState {
  return openCanvas({ size: DEFAULT_PROTOTYPE_VIEWPORT, ...opts });
}

const design: PrototypeOption = {
  kind: "choice",
  name: "design",
  values: ["mist", "slate", "paper"],
  default: "mist",
  group: null,
};

const v3: PrototypeVersion = {
  n: 3,
  sha: "abc",
  at: "2026-09-20T00:00:00Z",
  kind: "turn",
  subject: "Try avatars",
  conversationId: null,
  messageId: null,
  options: [],
};

function run(
  state: CanvasState,
  action: CanvasAction,
  shared: Record<string, string> = {},
) {
  return canvasReducer(state, action, shared);
}

function proto(state: CanvasState, index: number): PrototypeFrame {
  const f = prototypeFrames(state.frames)[index];
  if (!f) throw new Error(`no prototype frame ${String(index)}`);
  return f;
}

describe("initialCanvasState", () => {
  it("opens on frame A alone, holding the shared picks", () => {
    const s = initialCanvasState();
    expect(s.frames).toEqual([
      { id: 1, kind: "prototype", version: null, picks: "shared" },
    ]);
    expect(s.selected).toBe(1);
  });

  it("opens at the size the prototype declares", () => {
    expect(openCanvas({ size: { kind: "responsive" } }).size).toEqual({
      kind: "responsive",
    });
    expect(
      openCanvas({ size: { kind: "preset", preset: "Phone" } }).size,
    ).toEqual({ kind: "preset", preset: "Phone" });
  });

  it("puts a source beside A when asked", () => {
    const s = initialCanvasState({ source: "real-app" });
    expect(s.frames.map((f) => f.kind)).toEqual(["prototype", "source"]);
  });
});

describe("addPrototype", () => {
  it("copies the last prototype frame, snapshotting the shared picks", () => {
    const s0 = run(initialCanvasState({ version: v3 }), {
      type: "setVersion",
      id: 1,
      version: v3,
    }).state;
    const { state, effects } = run(
      s0,
      { type: "addPrototype" },
      { design: "slate" },
    );
    expect(effects).toEqual([]);
    const b = proto(state, 1);
    expect(b.picks).toEqual({ design: "slate" });
    expect(b.version).toBe(v3);
    expect(state.selected).toBe(b.id);
    // A still reads the shared record.
    expect(proto(state, 0).picks).toBe("shared");
  });

  it("duplicates the named frame", () => {
    let s = run(initialCanvasState(), { type: "addPrototype" }).state;
    s = run(s, {
      type: "setPick",
      id: 2,
      option: "design",
      value: "paper",
    }).state;
    s = run(s, { type: "addPrototype", from: 1 }, { design: "slate" }).state;
    expect(proto(s, 2).picks).toEqual({ design: "slate" });
  });

  it("shows the version asked for, keeping the copied frame's picks", () => {
    const s0 = run(initialCanvasState({ version: v3 }), {
      type: "setPick",
      id: 1,
      option: "design",
      value: "paper",
    }).state;
    const { state } = run(
      s0,
      { type: "addPrototype", from: 1, version: null },
      { design: "paper" },
    );
    const b = proto(state, 1);
    expect(b.version).toBeNull();
    expect(b.picks).toEqual({ design: "paper" });
    expect(proto(state, 0).version).toBe(v3);
  });

  it("makes a new frame A when only sources are left", () => {
    let s = initialCanvasState({ source: "real-app" });
    s = run(s, { type: "keepOnly", id: 2 }).state;
    const { state } = run(s, { type: "addPrototype" });
    expect(frameA(state.frames)?.picks).toBe("shared");
  });
});

describe("addSource", () => {
  it("adds a source once", () => {
    let s = run(initialCanvasState(), {
      type: "addSource",
      source: "real-app",
    }).state;
    s = run(s, { type: "addSource", source: "real-app" }).state;
    expect(s.frames.filter((f) => f.kind === "source")).toHaveLength(1);
  });

  it("switches to swipe at the responsive size", () => {
    const s = run(
      { ...initialCanvasState(), size: { kind: "window" } },
      { type: "addSource", source: "real-app" },
    ).state;
    expect(s.layout).toBe("swipe");
    expect(s.size).toEqual({ kind: "responsive" });
  });

  it("stays side by side when it does not make two frames", () => {
    let s = run(initialCanvasState(), { type: "addPrototype" }).state;
    s = run(s, { type: "addSource", source: "real-app" }).state;
    expect(s.frames).toHaveLength(3);
    expect(s.layout).toBe("side");
  });
});

describe("picks", () => {
  it("writes frame A's pick to the shared record, a local frame's in place", () => {
    const s = run(initialCanvasState(), { type: "addPrototype" }).state;
    const a = run(s, {
      type: "setPick",
      id: 1,
      option: "design",
      value: "paper",
    });
    expect(a.effects).toEqual([
      { kind: "setShared", option: "design", value: "paper" },
    ]);
    const b = run(s, {
      type: "setPick",
      id: 2,
      option: "design",
      value: "paper",
    });
    expect(b.effects).toEqual([]);
    expect(proto(b.state, 1).picks).toEqual({ design: "paper" });
  });

  it("fans a linked option out to every prototype frame", () => {
    let s = run(initialCanvasState(), { type: "addPrototype" }).state;
    s = run(s, { type: "toggleLink", id: 2, option: design }).state;
    const { state, effects } = run(s, {
      type: "setPick",
      id: 2,
      option: "design",
      value: "slate",
    });
    expect(proto(state, 1).picks).toEqual({ design: "slate" });
    expect(effects).toEqual([
      { kind: "setShared", option: "design", value: "slate" },
    ]);
  });

  it("linking copies the linking frame's value everywhere", () => {
    let s = run(initialCanvasState(), { type: "addPrototype" }).state;
    s = run(s, {
      type: "setPick",
      id: 2,
      option: "design",
      value: "paper",
    }).state;
    const { state, effects } = run(s, {
      type: "toggleLink",
      id: 2,
      option: design,
    });
    expect(state.linked.has("design")).toBe(true);
    expect(effects).toEqual([
      { kind: "setShared", option: "design", value: "paper" },
    ]);
    const unlinked = run(state, {
      type: "toggleLink",
      id: 2,
      option: design,
    }).state;
    expect(unlinked.linked.has("design")).toBe(false);
  });
});

describe("spread", () => {
  it("spreads one frame per value, keeping the base frame, and gathers back", () => {
    const s = initialCanvasState({ source: "real-app" });
    const { state, effects } = run(
      s,
      { type: "toggleSpread", id: 1, option: design },
      { design: "slate" },
    );
    expect(state.spread).toBe("design");
    const protos = prototypeFrames(state.frames);
    expect(protos.map((f) => f.id)).toEqual([3, 1, 4]);
    expect(state.frames.at(-1)?.kind).toBe("source");
    // Frame 3 (Mist) is first, so it is A now: its picks became the shared
    // record, and the base kept what it showed as its own.
    expect(frameA(state.frames)?.id).toBe(3);
    expect(protos[0]!.picks).toBe("shared");
    expect(effects).toEqual([
      { kind: "replaceShared", picks: { design: "mist" } },
    ]);
    expect(protos[1]!.picks).toEqual({ design: "slate" });

    const back = run(
      state,
      { type: "toggleSpread", id: 1, option: design },
      { design: "mist" },
    );
    expect(back.state.spread).toBeNull();
    expect(back.state.frames.map((f) => f.id)).toEqual([1, 2]);
    expect(proto(back.state, 0).picks).toBe("shared");
    expect(back.effects).toEqual([
      { kind: "replaceShared", picks: { design: "slate" } },
    ]);
  });

  it("a pick on the spread option ends the spread", () => {
    let s = run(initialCanvasState(), {
      type: "toggleSpread",
      id: 1,
      option: design,
    }).state;
    s = run(s, {
      type: "setPick",
      id: 1,
      option: "design",
      value: "paper",
    }).state;
    expect(s.spread).toBeNull();
  });
});

const accent: ColorOption = {
  kind: "color",
  name: "accent",
  suggestions: [
    { name: "violet", color: "#7c5cff" },
    { name: "azure", color: "#3b82f6" },
  ],
  default: "#7c5cff",
  group: null,
};

describe("color preview", () => {
  it("a drag previews without an effect; the pick commits it in one write", () => {
    const s0 = initialCanvasState();
    const moves = ["#3b82f6", "#3c82f6", "#3d83f7"];
    let s = s0;
    for (const value of moves) {
      const t = run(s, { type: "previewPick", id: 1, option: "accent", value });
      expect(t.effects).toEqual([]);
      s = t.state;
    }
    expect(s.preview).toEqual({ id: 1, option: "accent", value: "#3d83f7" });
    expect(previewedValue(s, 1, "accent")).toBe("#3d83f7");
    // The picks did not move.
    expect(s.frames).toBe(s0.frames);

    const done = run(s, {
      type: "setPick",
      id: 1,
      option: "accent",
      value: "#3d83f7",
    });
    expect(done.effects).toEqual([
      { kind: "setShared", option: "accent", value: "#3d83f7" },
    ]);
    expect(done.state.preview).toBeNull();
  });

  it("the same preview again is no change", () => {
    const s = run(initialCanvasState(), {
      type: "previewPick",
      id: 1,
      option: "accent",
      value: "azure",
    }).state;
    expect(
      run(s, { type: "previewPick", id: 1, option: "accent", value: "azure" })
        .state,
    ).toBe(s);
  });

  it("shows on its own frame, or every frame when the option is linked", () => {
    let s = run(initialCanvasState(), { type: "addPrototype" }).state;
    s = run(s, {
      type: "previewPick",
      id: 2,
      option: "accent",
      value: "azure",
    }).state;
    expect(previewedValue(s, 2, "accent")).toBe("azure");
    expect(previewedValue(s, 1, "accent")).toBeNull();
    expect(previewedValue(s, 2, "other")).toBeNull();
    s = run(s, { type: "toggleLink", id: 2, option: accent }).state;
    expect(previewedValue(s, 1, "accent")).toBe("azure");
  });

  it("clears on clearPreview, on reset, and with its frame", () => {
    let s = run(initialCanvasState(), { type: "addPrototype" }).state;
    const preview = (id: number) =>
      run(s, { type: "previewPick", id, option: "accent", value: "azure" })
        .state;
    expect(run(preview(2), { type: "clearPreview" }).state.preview).toBeNull();
    expect(
      run(preview(2), { type: "resetPicks", id: 2 }).state.preview,
    ).toBeNull();
    const reset = run(preview(1), { type: "resetPicks", id: 1 });
    expect(reset.state.preview).toBeNull();
    expect(reset.effects).toEqual([{ kind: "resetShared" }]);
    expect(run(preview(2), { type: "remove", id: 2 }).state.preview).toBeNull();
    s = preview(2);
    // A pick of another option leaves the drag alone.
    expect(
      run(s, { type: "setPick", id: 2, option: "design", value: "paper" }).state
        .preview,
    ).toEqual(s.preview);
  });

  it("is the only transient action", () => {
    expect(
      isTransientAction({
        type: "previewPick",
        id: 1,
        option: "accent",
        value: "azure",
      }),
    ).toBe(true);
    expect(isTransientAction({ type: "clearPreview" })).toBe(true);
    expect(
      isTransientAction({
        type: "setPick",
        id: 1,
        option: "accent",
        value: "azure",
      }),
    ).toBe(false);
  });
});

describe("color spread", () => {
  it("spreads a color option over its suggestions", () => {
    const { state } = run(
      initialCanvasState(),
      { type: "toggleSpread", id: 1, option: accent },
      { accent: "azure" },
    );
    expect(state.spread).toBe("accent");
    const protos = prototypeFrames(state.frames);
    expect(protos.map((f) => f.id)).toEqual([2, 1]);
    expect(protos[1]!.picks).toEqual({ accent: "azure" });
  });

  it("a custom color keeps its frame, first", () => {
    expect(spreadValues(accent, "#10b981")).toEqual([
      "#10b981",
      "violet",
      "azure",
    ]);
    const { state } = run(
      initialCanvasState(),
      { type: "toggleSpread", id: 1, option: accent },
      { accent: "#10b981" },
    );
    expect(prototypeFrames(state.frames).map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it("a color with no suggestions has nothing to spread", () => {
    const bare = { ...accent, suggestions: [] };
    const s = initialCanvasState();
    expect(run(s, { type: "toggleSpread", id: 1, option: bare }).state).toBe(s);
  });
});

describe("remove and keepOnly", () => {
  it("never removes the last frame", () => {
    const s = initialCanvasState();
    expect(run(s, { type: "remove", id: 1 }).state).toBe(s);
  });

  it("promotes the next prototype frame to A, writing its picks to the shared record", () => {
    let s = run(initialCanvasState(), { type: "addPrototype" }).state;
    s = run(s, {
      type: "setPick",
      id: 2,
      option: "design",
      value: "paper",
    }).state;
    const { state, effects } = run(s, { type: "remove", id: 1 });
    expect(proto(state, 0)).toMatchObject({ id: 2, picks: "shared" });
    expect(effects).toEqual([
      { kind: "replaceShared", picks: { design: "paper" } },
    ]);
    expect(state.selected).toBe(2);
  });

  it("keeps one frame, and Undo puts the canvas and the shared record back", () => {
    let s = run(initialCanvasState({ source: "real-app" }), {
      type: "addPrototype",
    }).state;
    s = run(s, { type: "setLayout", layout: "swipe" }).state;
    const before = s;
    const kept = run(s, { type: "keepOnly", id: 3 }, { design: "slate" });
    expect(kept.state.frames.map((f) => f.id)).toEqual([3]);
    expect(kept.state.layout).toBe("side");
    const undone = run(kept.state, {
      type: "restore",
      state: before,
      shared: { design: "slate" },
    });
    expect(undone.state).toBe(before);
    expect(undone.effects).toEqual([
      { kind: "replaceShared", picks: { design: "slate" } },
    ]);
  });
});

describe("swipe layout", () => {
  const swiping = (): CanvasState =>
    run(initialCanvasState({ source: "real-app" }), {
      type: "setLayout",
      layout: "swipe",
    }).state;

  it("drops back to side by side when a frame is added", () => {
    const s = swiping();
    expect(s.layout).toBe("swipe");
    expect(run(s, { type: "addPrototype" }).state.layout).toBe("side");
  });

  it("drops back to side by side when a frame is closed", () => {
    expect(run(swiping(), { type: "remove", id: 2 }).state.layout).toBe("side");
  });
});

describe("canvas-wide settings", () => {
  it("clamps the swipe divider", () => {
    const s = run(initialCanvasState(), { type: "setSwipeAt", at: 3 }).state;
    expect(s.swipeAt).toBe(1);
  });
});
