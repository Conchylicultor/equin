import { expect, it } from "bun:test";
import type {
  ChoiceOption,
  PrototypeVersion,
} from "@plugins/apps/plugins/prototypes/plugins/files/core";
import {
  canvasReducer,
  initialCanvasState,
  type CanvasAction,
  type CanvasState,
} from "./canvas-model";
import { restoreCanvas, serializeCanvas } from "./saved-canvas";

const design: ChoiceOption = {
  kind: "choice",
  name: "design",
  values: ["mist", "slate", "paper"],
  default: "mist",
  group: null,
};
const page: ChoiceOption = {
  kind: "choice",
  name: "page",
  values: ["home", "list"],
  default: "home",
  group: null,
};
const v3: PrototypeVersion = {
  n: 3,
  sha: "abc",
  at: "2026-09-20T00:00:00Z",
  kind: "turn",
  subject: "x",
  conversationId: null,
  messageId: null,
  options: [design],
};

// A fixed-seed LCG: the same sequences on every run, so a failure reproduces.
let seed = 1;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

function randomAction(s: CanvasState): CanvasAction {
  const ids = [...s.frames.map((f) => f.id), 99];
  const id = ids[rnd(ids.length)]!;
  const opt = [design, page][rnd(2)]!;
  const acts: CanvasAction[] = [
    { type: "addPrototype" },
    { type: "addPrototype", from: id },
    { type: "addPrototype", from: id, version: v3 },
    { type: "addSource", source: "real-app" },
    { type: "remove", id },
    { type: "keepOnly", id },
    { type: "select", id },
    { type: "setVersion", id, version: rnd(2) ? v3 : null },
    {
      type: "setPick",
      id,
      option: opt.name,
      value: opt.values[rnd(opt.values.length)]!,
    },
    { type: "resetPicks", id },
    { type: "toggleLink", id, option: opt },
    { type: "toggleSpread", id, option: opt },
    {
      type: "setSize",
      size: rnd(2)
        ? { kind: "preset", preset: "Phone" }
        : { kind: "custom", w: 500, h: 800 },
    },
    { type: "setZoom", zoom: rnd(2) ? "fit" : 0.5 },
    { type: "setWholePage", on: !!rnd(2) },
    { type: "setLayout", layout: rnd(2) ? "swipe" : "side" },
    { type: "setSwipeAt", at: rnd(3) / 2 },
  ];
  return acts[rnd(acts.length)]!;
}

/**
 * Every canvas the reducer can reach is one `restoreCanvas` reopens: random
 * action sequences (ids that are not on the canvas included) are saved after
 * each step and read back. A rule the reducer and the saved-canvas check
 * disagree on loses the whole canvas on the next reload.
 */
it("every reachable canvas reopens after a reload", () => {
  const failures = new Map<string, string>();
  for (let run = 0; run < 600; run++) {
    let s = initialCanvasState({ size: { kind: "window" } });
    const trail: string[] = [];
    for (let step = 0; step < 25; step++) {
      const a = randomAction(s);
      trail.push(JSON.stringify(a).slice(0, 90));
      s = canvasReducer(s, a, { design: "slate" }).state;
      const back = restoreCanvas(
        JSON.parse(JSON.stringify(serializeCanvas(s))),
      );
      if (back.kind === "rejected" && !failures.has(back.reason.slice(0, 80))) {
        failures.set(back.reason.slice(0, 80), trail.join("\n  "));
        break;
      }
    }
  }
  for (const [r, t] of failures) console.log("REJECT:", r, "\n  " + t);
  expect(failures.size).toBe(0);
});
