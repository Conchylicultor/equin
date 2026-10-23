import { describe, expect, it } from "bun:test";
import {
  emptyScore,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { busiestWindow } from "./window";

let seq = 0;
const note = (start: number, pitch: number, duration = 1): Note => ({
  id: `n${seq++}`,
  pitch,
  start,
  duration,
  velocity: 90,
  track: "t",
});
const score = (notes: Note[], over: Partial<Score> = {}): Score => ({
  ...emptyScore(),
  tracks: [{ id: "t" }],
  notes,
  ...over,
});

describe("busiestWindow", () => {
  it("picks the bar-aligned stretch with the most note starts", () => {
    // Bars 1-4: 4 notes; bars 5-8 (beats 16..32): 10 notes.
    const notes = [
      ...[0, 4, 8, 12].map((b) => note(b, 60)),
      ...Array.from({ length: 10 }, (_, i) => note(16 + i * 1.5, 64)),
    ];
    const w = busiestWindow(score(notes));
    expect(w.startBeat).toBe(16);
    expect(w.endBeat).toBe(32);
  });

  it("measures bars from the first time signature", () => {
    const notes = Array.from({ length: 30 }, (_, i) => note(i, 60));
    const w = busiestWindow(
      score(notes, { timeSigMap: [{ beat: 0, numerator: 3, denominator: 4 }] }),
      2,
    );
    expect(w.endBeat - w.startBeat).toBe(6);
  });

  it("ties go to the earliest window", () => {
    const notes = [0, 1, 2, 3, 16, 17, 18, 19].map((b) => note(b, 60));
    expect(busiestWindow(score(notes)).startBeat).toBe(0);
  });

  it("pads the pitch range to whole octaves, at least two", () => {
    const w = busiestWindow(score([note(0, 62), note(1, 65)]));
    expect(w.lowPitch % 12).toBe(0);
    expect(w.highPitch % 12).toBe(11);
    expect(w.lowPitch).toBeLessThanOrEqual(62);
    expect(w.highPitch).toBeGreaterThanOrEqual(65);
    expect((w.highPitch + 1 - w.lowPitch) / 12).toBe(2);
  });

  it("covers notes sounding into the window, not only those starting in it", () => {
    const notes = [
      note(0, 30, 24), // a held low note from bar 1 into the busy window
      ...Array.from({ length: 16 }, (_, i) => note(16 + i, 72)),
    ];
    const w = busiestWindow(score(notes));
    expect(w.startBeat).toBe(16);
    expect(w.lowPitch).toBeLessThanOrEqual(30);
    expect(w.highPitch).toBeGreaterThanOrEqual(72);
  });

  it("an empty score gets two octaves around middle C", () => {
    expect(busiestWindow(score([]))).toEqual({
      startBeat: 0,
      endBeat: 16,
      lowPitch: 48,
      highPitch: 71,
    });
  });
});
