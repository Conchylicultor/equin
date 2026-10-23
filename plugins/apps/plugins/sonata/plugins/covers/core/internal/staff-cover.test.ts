import { describe, expect, it } from "bun:test";
import {
  emptyScore,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { renderStaffCover } from "./staff-cover";

let seq = 0;
const note = (
  start: number,
  pitch: number,
  track: string,
  duration = 1,
): Note => ({
  id: `n${seq++}`,
  pitch,
  start,
  duration,
  velocity: 100,
  track,
});
const score = (notes: Note[], tracks = ["rh", "lh"]): Score => ({
  ...emptyScore(),
  tracks: tracks.map((id) => ({ id })),
  notes,
});

/** Every notehead's centre y, in document order. */
const headYs = (svg: string) =>
  [...svg.matchAll(/<ellipse cx="[\d.]+" cy="([\d.]+)"/g)].map((m) =>
    Number(m[1]),
  );

describe("renderStaffCover", () => {
  it("an empty score draws the empty grand staff", () => {
    const svg = renderStaffCover(emptyScore());
    expect(headYs(svg)).toHaveLength(0);
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("puts the higher track on the treble staff and the lower on the bass", () => {
    const ys = headYs(
      renderStaffCover(score([note(0, 43, "lh"), note(0, 76, "rh")])),
    );
    // E5 inside the treble staff (lines 44..72); G2 on the bass bottom line (150).
    expect(ys).toHaveLength(2);
    expect(ys.some((y) => y >= 44 && y <= 72)).toBe(true);
    expect(ys).toContain(150);
  });

  it("places heads by diatonic step: E4 on the treble bottom line, F5 on the top", () => {
    const ys = headYs(
      renderStaffCover(score([note(0, 64, "rh"), note(1, 77, "rh")], ["rh"])),
    );
    expect(ys).toEqual([72, 44]);
  });

  it("caps each staff at twelve noteheads", () => {
    const notes = Array.from({ length: 40 }, (_, i) => note(i, 72, "rh"));
    expect(headYs(renderStaffCover(score(notes, ["rh"])))).toHaveLength(12);
  });

  it("draws at most two ledger lines, moving a far note an octave closer", () => {
    // C7 is far above the treble staff: drawn as C6, on its second ledger line.
    const svg = renderStaffCover(score([note(0, 96, "rh")], ["rh"]));
    expect([...svg.matchAll(/width="13"/g)]).toHaveLength(2);
  });

  it("spells by the song's key: F♯ needs a sharp in C, none in G major", () => {
    const fSharp = [note(0, 66, "rh")];
    expect(renderStaffCover(score(fSharp, ["rh"]))).toContain("♯");
    const inG = renderStaffCover({
      ...score(fSharp, ["rh"]),
      meta: { key: { tonic: "G", mode: "major" } },
    });
    expect(inG).not.toContain("♯");
  });

  it("is deterministic", () => {
    const s = score([note(0, 72, "rh"), note(1, 74, "rh"), note(0, 48, "lh")]);
    expect(renderStaffCover(s)).toBe(renderStaffCover(s));
  });
});
