import { describe, expect, it } from "bun:test";
import {
  DEFAULT_PROTOTYPE_VIEWPORT,
  type PrototypeOption,
  type PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  canvasReducer,
  initialCanvasState,
  type CanvasAction,
  type CanvasState,
} from "./canvas-model";
import { restoreCanvas, serializeCanvas } from "./saved-canvas";

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
  options: [design],
};

/** Through storage and back: JSON, as localStorage holds it. */
function roundTrip(state: CanvasState) {
  return restoreCanvas(JSON.parse(JSON.stringify(serializeCanvas(state))));
}

function apply(state: CanvasState, ...actions: CanvasAction[]): CanvasState {
  return actions.reduce(
    (s, a) => canvasReducer(s, a, { design: "slate" }).state,
    state,
  );
}

describe("saved canvas", () => {
  it("reopens a worked canvas exactly as it was left", () => {
    const state = apply(
      initialCanvasState({
        size: DEFAULT_PROTOTYPE_VIEWPORT,
        source: "real-app",
      }),
      { type: "addPrototype" },
      { type: "setVersion", id: 3, version: v3 },
      { type: "setPick", id: 3, option: "design", value: "paper" },
      { type: "toggleLink", id: 3, option: design },
      { type: "setSize", size: { kind: "preset", preset: "Phone" } },
      { type: "setZoom", zoom: 0.5 },
      { type: "setWholePage", on: true },
    );
    const back = roundTrip(state);
    expect(back).toEqual({ kind: "restored", state });
    if (back.kind === "restored") {
      expect(back.state.linked).toBeInstanceOf(Set);
    }
  });

  it("keeps frame A on the shared record, never a copy of it", () => {
    const back = roundTrip(
      apply(initialCanvasState({ size: DEFAULT_PROTOTYPE_VIEWPORT }), {
        type: "addPrototype",
      }),
    );
    expect(back.kind).toBe("restored");
    if (back.kind === "restored") {
      const [a, b] = back.state.frames;
      expect(a).toMatchObject({ kind: "prototype", picks: "shared" });
      expect(b).toMatchObject({
        kind: "prototype",
        picks: { design: "slate" },
      });
    }
  });

  it("rejects what an older canvas shape wrote", () => {
    expect(restoreCanvas({ frames: [] }).kind).toBe("rejected");
    expect(restoreCanvas("nope").kind).toBe("rejected");
  });

  it("rejects a canvas that breaks the reducer's rules", () => {
    const ok = serializeCanvas(
      apply(initialCanvasState({ size: DEFAULT_PROTOTYPE_VIEWPORT }), {
        type: "addPrototype",
      }),
    );
    const cases: [string, unknown][] = [
      [
        "shared picks off frame A",
        {
          ...ok,
          frames: [
            { ...ok.frames[0], picks: {} },
            { ...ok.frames[1], picks: "shared" },
          ],
        },
      ],
      ["selection off the canvas", { ...ok, selected: 9 }],
      ["id at nextId", { ...ok, nextId: 2 }],
    ];
    for (const [label, raw] of cases) {
      expect([label, restoreCanvas(raw).kind]).toEqual([label, "rejected"]);
    }
  });

  it("reopens a canvas that was swiping when a frame was added", () => {
    // The lost-on-reload case: Swipe with two frames, then + Frame.
    const state = apply(
      initialCanvasState({
        size: DEFAULT_PROTOTYPE_VIEWPORT,
        source: "real-app",
      }),
      { type: "setLayout", layout: "swipe" },
      { type: "addPrototype" },
    );
    expect(roundTrip(state)).toEqual({ kind: "restored", state });
  });

  it("reopens side by side a swipe canvas saved without two frames", () => {
    const ok = serializeCanvas(
      apply(initialCanvasState({ size: DEFAULT_PROTOTYPE_VIEWPORT }), {
        type: "addPrototype",
      }),
    );
    for (const frames of [
      [ok.frames[0]],
      [...ok.frames, { id: 3, kind: "source", source: "real-app" }],
    ]) {
      const back = restoreCanvas({
        ...ok,
        frames,
        nextId: 4,
        selected: 1,
        layout: "swipe",
      });
      expect(back.kind).toBe("restored");
      if (back.kind === "restored") expect(back.state.layout).toBe("side");
    }
  });
});
