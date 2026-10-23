import { describe, expect, it } from "bun:test";
import {
  SONATA_DEFAULT_LOOK,
  SONATA_LOOK_STYLES,
} from "@plugins/apps/plugins/sonata/plugins/look/core";
import {
  emptyScore,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { renderRollCover } from "./roll-cover";

const TRACKS = SONATA_LOOK_STYLES[SONATA_DEFAULT_LOOK].tracks;

let seq = 0;
const note = (start: number, pitch: number, track: string): Note => ({
  id: `n${seq++}`,
  pitch,
  start,
  duration: 1,
  velocity: 100,
  track,
});

const twoHands = (): Score => ({
  ...emptyScore(),
  tracks: [{ id: "rh" }, { id: "lh" }],
  notes: [
    ...[0, 1, 2, 3, 4, 5].map((b) => note(b, 72 + (b % 3), "rh")),
    ...[0, 2, 4].map((b) => note(b, 48, "lh")),
  ],
});

/** Every note rect's track index and fill, in document order. */
function noteFills(svg: string): { track: number; fill: string }[] {
  return [
    ...svg.matchAll(
      /<rect class="note" data-track="(\d+)"[^>]* fill="([^"]+)"/g,
    ),
  ].map((m) => ({ track: Number(m[1]), fill: m[2]! }));
}

describe("renderRollCover", () => {
  it("draws one rect per note in the window", () => {
    expect(noteFills(renderRollCover(twoHands()))).toHaveLength(9);
  });

  it("colours each note by its track's index through the look's palette", () => {
    const fills = noteFills(renderRollCover(twoHands()));
    for (const { track, fill } of fills) expect(fill).toBe(TRACKS[track]!);
    expect(new Set(fills.map((x) => x.fill))).toEqual(
      new Set([TRACKS[0]!, TRACKS[1]!]),
    );
  });

  it("is deterministic", () => {
    expect(renderRollCover(twoHands())).toBe(renderRollCover(twoHands()));
  });

  it("is a 320×200 SVG", () => {
    const svg = renderRollCover(twoHands());
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 320 200"');
  });

  it("glows the notes sounding at the bottom edge", () => {
    expect(renderRollCover(twoHands())).toContain('filter="url(#glow)"');
  });

  it("an empty score draws an empty roll", () => {
    const svg = renderRollCover(emptyScore());
    expect(noteFills(svg)).toHaveLength(0);
    expect(svg).not.toContain('filter="url(#glow)"');
    expect(svg.endsWith("</svg>")).toBe(true);
  });
});
