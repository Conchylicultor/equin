import { describe, expect, it } from "bun:test";
import type { Song } from "../../core";
import type { SongCoverAnswer } from "../slots";
import { resolveSongCover, type SongCoverSource } from "./resolve-cover";

const song = { id: "song-1" } as Song;

const ART: SongCoverAnswer = {
  kind: "art",
  content: { kind: "image", src: "/cover.svg" },
};
const PENDING: SongCoverAnswer = { kind: "pending", label: "Transcribing" };
const FAILED: SongCoverAnswer = { kind: "failed", message: "render failed" };

const source = (id: string, answer: SongCoverAnswer | undefined) =>
  ({ id, cover: () => answer }) satisfies SongCoverSource;

/** Every ordering of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

describe("resolveSongCover", () => {
  it("is undefined when no source answers", () => {
    expect(resolveSongCover([], song)).toBeUndefined();
    expect(
      resolveSongCover([source("a", undefined), source("b", undefined)], song),
    ).toBeUndefined();
  });

  it("returns the one art answer", () => {
    expect(
      resolveSongCover([source("a", undefined), source("b", ART)], song),
    ).toBe(ART);
  });

  it("ranks failed over pending over art, whatever the order", () => {
    for (const order of permutations([
      source("art", ART),
      source("pending", PENDING),
      source("failed", FAILED),
    ])) {
      expect(resolveSongCover(order, song)).toBe(FAILED);
    }
    for (const order of permutations([
      source("art", ART),
      source("pending", PENDING),
      source("none", undefined),
    ])) {
      expect(resolveSongCover(order, song)).toBe(PENDING);
    }
  });

  it("throws on two art answers for one song, naming both sources", () => {
    expect(() =>
      resolveSongCover([source("midi", ART), source("chords", ART)], song),
    ).toThrow(/"midi" and "chords" both answer art for song "song-1"/);
  });

  it("throws on two art answers even when a failure would win", () => {
    expect(() =>
      resolveSongCover(
        [source("failed", FAILED), source("a", ART), source("b", ART)],
        song,
      ),
    ).toThrow(/both answer art/);
  });
});
