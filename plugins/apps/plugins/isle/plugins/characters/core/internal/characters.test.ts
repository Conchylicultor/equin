import { describe, expect, test } from "bun:test";
import {
  boxWithin,
  paintedExtent,
} from "@plugins/apps/plugins/isle/plugins/buildings/core/testing";
import {
  CHARACTER_BOX,
  IDLE_FRAMES,
  STRIDE,
  WALK_FRAMES,
  characterFrame,
  createTurnTracker,
  poseKey,
  type CharacterPose,
  type CharacterView,
} from "./frame";
import { LOOK_NAMES } from "./looks";
import { paintCharacterPose, paintCharacterShadow } from "./paint";

const BOX = [
  -CHARACTER_BOX.ox,
  -CHARACTER_BOX.oy,
  CHARACTER_BOX.w - CHARACTER_BOX.ox,
  CHARACTER_BOX.h - CHARACTER_BOX.oy,
] as const;

describe("characterFrame", () => {
  test("is deterministic", () => {
    const s = {
      look: "villager2",
      facing: 0.3,
      walking: false,
      t: 12.34,
    } as const;
    expect(characterFrame(s)).toEqual(characterFrame(s));
  });

  test("idle toward the viewer by default", () => {
    const f = characterFrame({ look: "hero", walking: false, t: 0 });
    expect(f.from).toBeNull();
    expect(f.to.pose.view).toBe("front");
    expect(f.to.pose.mode).toBe("idle");
    expect(f.to.flip).toBe(false);
    expect(f.to.alpha).toBe(1);
  });

  test("walking right picks the walk frame from phase / STRIDE", () => {
    // hero: h 0.9, stride 1 -> one cycle every STRIDE * 0.9 px
    const cycle = STRIDE * 0.9;
    const at = (phase: number) =>
      characterFrame({ look: "hero", facing: 0, walking: true, t: 0, phase })
        .to;
    expect(at(0).pose).toMatchObject({ view: "side", mode: "walk", frame: 0 });
    expect(at(0).flip).toBe(false);
    expect(at(cycle / 2).pose.frame).toBe(WALK_FRAMES / 2);
    expect(at(cycle * 1.25).pose.frame).toBe(WALK_FRAMES / 4);
    expect(at(-cycle * 0.25).pose.frame).toBe((WALK_FRAMES * 3) / 4);
  });

  test("the elder's shorter stride lengthens his cycle", () => {
    const cycle = STRIDE * 0.94 * 0.75;
    const f = characterFrame({
      look: "villager3",
      facing: 0,
      walking: true,
      t: 0,
      phase: cycle / 2,
    });
    expect(f.to.pose.frame).toBe(WALK_FRAMES / 2);
  });

  test("facing left mirrors the side view; away shows the back", () => {
    expect(
      characterFrame({ look: "hero", facing: Math.PI, walking: true, t: 0 }).to,
    ).toMatchObject({
      flip: true,
      pose: { view: "side" },
    });
    expect(
      characterFrame({
        look: "hero",
        facing: -Math.PI / 2,
        walking: true,
        t: 0,
      }).to,
    ).toMatchObject({
      flip: false,
      pose: { view: "back" },
    });
  });

  test("idle frames, blink and gaze follow the clock", () => {
    const frames = new Set<number>();
    let blinks = 0;
    const gazes = new Set<number>();
    for (let t = 0; t < 60; t += 0.01) {
      const p = characterFrame({
        look: "villager1",
        facing: Math.PI / 2,
        walking: false,
        t,
      }).to.pose;
      frames.add(p.frame);
      if (p.blink) blinks++;
      gazes.add(p.gaze);
      const side = characterFrame({
        look: "villager1",
        facing: 0,
        walking: false,
        t,
      }).to.pose;
      expect(side.gaze).toBe(0);
    }
    expect(frames.size).toBe(IDLE_FRAMES);
    expect(blinks).toBeGreaterThan(0);
    expect([...gazes].sort()).toEqual([-1, 0, 1]);
  });

  test("a turn cross-fades over 0.12 s, then settles", () => {
    const tracker = createTurnTracker();
    const frameAt = (facing: number, t: number) =>
      characterFrame({
        look: "hero",
        facing,
        walking: true,
        t,
        turn: tracker.observe("hero", facing, t),
      });
    const first = frameAt(0, 0);
    expect(first.from).toBeNull();
    const mid = frameAt(Math.PI / 2, 1);
    expect(mid.from?.pose.view).toBe("side");
    expect(mid.to.pose.view).toBe("front");
    expect(mid.to.alpha).toBe(0);
    const half = frameAt(Math.PI / 2, 1.06);
    expect(half.to.alpha).toBeCloseTo(0.5, 6);
    expect(half.from?.alpha).toBeCloseTo(0.5, 6);
    const done = frameAt(Math.PI / 2, 1.2);
    expect(done.from).toBeNull();
    expect(done.to.alpha).toBe(1);
  });

  test("poseKey is stable and ignores mirroring", () => {
    const a = characterFrame({
      look: "hero",
      facing: 0,
      walking: false,
      t: 3,
    }).to;
    const b = characterFrame({
      look: "hero",
      facing: Math.PI,
      walking: false,
      t: 3,
    }).to;
    expect(poseKey(a.pose)).toBe(poseKey(b.pose));
    expect(a.flip).not.toBe(b.flip);
  });
});

describe("paintCharacterPose", () => {
  const views: CharacterView[] = ["front", "back", "side"];
  test("every look, view, mode and frame paints inside CHARACTER_BOX", () => {
    for (const look of LOOK_NAMES)
      for (const view of views) {
        const poses: CharacterPose[] = [];
        for (let frame = 0; frame < WALK_FRAMES; frame++)
          poses.push({
            look,
            view,
            mode: "walk",
            frame,
            blink: false,
            gaze: 0,
          });
        for (let frame = 0; frame < IDLE_FRAMES; frame++)
          for (const [blink, gaze] of [
            [false, 0],
            [true, 0],
            [false, -1],
            [false, 1],
          ] as const)
            poses.push({ look, view, mode: "idle", frame, blink, gaze });
        for (const pose of poses) {
          const { above, below } = paintedExtent(
            (g) => paintCharacterPose(g, pose),
            0,
          );
          const ink = [above, below].filter((b) => b !== null);
          expect(ink.length).toBeGreaterThan(0);
          const box: [number, number, number, number] = [
            Math.min(...ink.map((b) => b[0])),
            Math.min(...ink.map((b) => b[1])),
            Math.max(...ink.map((b) => b[2])),
            Math.max(...ink.map((b) => b[3])),
          ];
          if (!boxWithin(box, BOX))
            throw new Error(
              `${poseKey(pose)} paints ${box.join(",")} outside ${BOX.join(",")}`,
            );
        }
      }
  });

  test("the shadow sits under the feet", () => {
    for (const look of LOOK_NAMES) {
      const { above, below } = paintedExtent(
        (g) => paintCharacterShadow(g, look),
        -10,
      );
      expect(above).toBeNull();
      expect(below && boxWithin(below, BOX)).toBe(true);
    }
  });
});
