import { describe, expect, it } from "bun:test";
import type { BeatFeatures } from "@plugins/infra/plugins/audio-analysis/core";
import {
  bars,
  beatToSeconds,
  type Annotation,
  type ChordData,
  type LyricData,
  type SectionData,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { parsedSheet, synthFeatures } from "../testing";
import { alignChords } from "./align";
import { GAP_SECTION_NAME, alignedScore, fitsSheet } from "./aligned-score";
import {
  ALIGNER_VERSION,
  WEAK_MATCH_THRESHOLD,
  sheetHash,
  type AlignmentRecord,
} from "./record";

const VERSE = ["C G Am F", "C G F C"];
const CHORUS = ["Am F C G"];
const VERSE_PLAYED = ["C", "G", "Am", "F", "C", "G", "F", "C"];
const CHORUS_PLAYED = ["Am", "F", "C", "G"];

function played(
  chords: readonly (string | null)[],
  beats = 4,
): (string | null)[] {
  return chords.flatMap((c) => Array.from({ length: beats }, () => c));
}

/** Beat times that drift around 120 bpm, so a tempo map has something to reproduce. */
function withDrift(features: BeatFeatures): BeatFeatures {
  let t = features.beats[0]!.t;
  const beats = features.beats.map((b, i) => {
    const beat = { ...b, t: Math.round(t * 1e4) / 1e4 };
    t += 0.5 + 0.04 * Math.sin(i / 3);
    return beat;
  });
  return { ...features, beats, durationSec: t };
}

function ofType<T>(
  score: { annotations: Annotation[] },
  type: string,
): Annotation<string, T>[] {
  return score.annotations.filter((a) => a.type === type) as Annotation<
    string,
    T
  >[];
}

const sheet = parsedSheet(
  [
    { name: "Verse", lines: VERSE },
    { name: "Chorus", lines: CHORUS },
    { name: "Chorus", lines: [] },
  ],
  { key: "C" },
);

function aligned(features: BeatFeatures): AlignmentRecord {
  return alignChords(sheet, features, {
    capo: 0,
    sheetHash: "h",
    settingsKey: "test",
  });
}

describe("alignedScore", () => {
  it("reproduces the detected beat times through its tempo map", () => {
    const features = withDrift(
      synthFeatures(
        played([...VERSE_PLAYED, ...CHORUS_PLAYED, ...CHORUS_PLAYED]),
      ),
    );
    const record = aligned(features);
    const score = alignedScore(sheet, record, "Song");
    // startSec 0.5 at ~0.5 s per beat: one lead-in beat.
    const n = 1;
    expect(score.tempoMap[0]!.beat).toBe(0);
    expect(beatToSeconds(score, 0)).toBe(0);
    record.beats.forEach((beat, i) => {
      expect(beatToSeconds(score, n + i)).toBeCloseTo(beat.t, 6);
    });
    expect(beatToSeconds(score, n + record.beats.length)).toBeCloseTo(
      record.durationSec,
      6,
    );
    expect(score.meta.title).toBe("Song");
    // The timebase it plays on: score seconds are this video's seconds.
    expect(score.meta.recording).toEqual({
      provider: "youtube",
      videoId: record.videoId,
      durationSec: record.durationSec,
    });
  });

  it("places a lead-in and a pickup bar before the first downbeat, and follows bar-length changes", () => {
    // First beat at 1.2 s (two lead-in beats at 100 bpm), first downbeat on beat 1.
    const base = synthFeatures(played([...VERSE_PLAYED, ...CHORUS_PLAYED]), {
      startSec: 1.2,
      firstDownbeat: 1,
    });
    // One 2-beat bar from beat 9: downbeats at 1, 5, 9, 11, 15, …
    const features: BeatFeatures = {
      ...base,
      beats: base.beats.map((b, i) => ({
        ...b,
        downbeat:
          i === 1 || i === 5 || i === 9 || (i >= 11 && (i - 11) % 4 === 0),
      })),
    };
    const record = aligned(features);
    const score = alignedScore(sheet, record);
    const n = 2;
    expect(score.tempoMap[0]).toEqual({ beat: 0, bpm: 100 });
    expect(score.meta.pickupBeats).toBe(n + 1);
    expect(score.timeSigMap).toEqual([
      { beat: 0, numerator: 4, denominator: 4 },
      { beat: n + 9, numerator: 2, denominator: 4 },
      { beat: n + 11, numerator: 4, denominator: 4 },
    ]);
    const downbeats = features.beats.flatMap((b, i) =>
      b.downbeat ? [n + i] : [],
    );
    const barStarts = bars(score).map((b) => b.startBeat);
    expect(barStarts[0]).toBe(0);
    expect(barStarts.slice(1, downbeats.length + 1)).toEqual(downbeats);
  });

  it("lays chords, lines and section occurrences out in performance order", () => {
    const features = synthFeatures(
      played([
        ...VERSE_PLAYED,
        ...CHORUS_PLAYED,
        ...CHORUS_PLAYED,
        ...CHORUS_PLAYED,
      ]),
    );
    const record = aligned(features);
    const score = alignedScore(sheet, record);
    const n = 1;

    const chords = ofType<ChordData>(score, "chord");
    expect(chords.map((c) => `${c.data.symbol}@${c.start - n}`)).toEqual(
      [
        ...VERSE_PLAYED,
        ...CHORUS_PLAYED,
        ...CHORUS_PLAYED,
        ...CHORUS_PLAYED,
      ].map((c, i) => `${c}@${i * 4}`),
    );
    const sections = ofType<SectionData>(score, "section");
    expect(
      sections.map((s) => `${s.data.name}@${s.start - n}-${s.end - n}`),
    ).toEqual(["Verse@0-32", "Chorus@32-48", "Chorus@48-64", "Chorus@64-80"]);
    const lyrics = ofType<LyricData>(score, "lyric");
    expect(lyrics.map((l) => l.start - n)).toEqual([0, 16, 32, 48, 64]);
    // Each line's chords sit on the beats they were found on.
    expect(lyrics[1]!.data.chords.map((c) => c.beat - n)).toEqual([
      16, 20, 24, 28,
    ]);
  });

  it("starts a line early enough to sing the words before its first chord", () => {
    const base = parsedSheet([{ name: "Verse", lines: VERSE }]);
    // The second line sings four columns before its first chord (C), at its
    // own pace: 24 columns over the 16 beats from C to the line's end.
    const lyricSheet = {
      ...base,
      sections: base.sections.map((section) => ({
        ...section,
        lines: section.lines.map((line, i) =>
          i === 0
            ? { ...line, lyric: "la ".repeat(8) }
            : {
                lyric: "la ".repeat(9) + "l",
                chords: line.chords.map((c, ci) => ({
                  ...c,
                  charOffset: 4 + ci * 6,
                })),
              },
        ),
      })),
    };
    const record = alignChords(
      lyricSheet,
      synthFeatures(played(VERSE_PLAYED)),
      {
        capo: 0,
        sheetHash: "h",
        settingsKey: "test",
      },
    );
    const n = 1;
    const lyrics = ofType<LyricData>(alignedScore(lyricSheet, record), "lyric");
    // 4 columns at 16/24 beats each: 2⅔ beats before its C, on beat 16.
    expect(lyrics[1]!.start - n).toBeCloseTo(16 - 8 / 3, 6);
    expect(lyrics[1]!.data.chords[0]!.beat - n).toBe(16);
    // The line before ends where it starts.
    expect(lyrics[0]!.end).toBeCloseTo(lyrics[1]!.start, 6);
  });

  it("names a gap 'Not in sheet'", () => {
    const features = synthFeatures(
      played([
        ...VERSE_PLAYED,
        "Ebm",
        "Bbm",
        "Ebm",
        "Bbm",
        "Abm",
        "Bbm",
        "Ebm",
        "Ebm",
        ...CHORUS_PLAYED,
      ]),
    );
    const record = aligned(features);
    const sections = ofType<SectionData>(
      alignedScore(sheet, record),
      "section",
    );
    expect(sections.map((s) => s.data.name)).toEqual([
      "Verse",
      GAP_SECTION_NAME,
      "Chorus",
    ]);
  });

  it("is at the recording's sounding pitch", () => {
    // The sheet two semitones up, as a capo 2 would sound.
    const features = synthFeatures(
      played([
        "D",
        "A",
        "Bm",
        "G",
        "D",
        "A",
        "G",
        "D",
        ...["Bm", "G", "D", "A"],
      ]),
    );
    const record = alignChords(sheet, features, {
      capo: 2,
      sheetHash: "h",
      settingsKey: "test",
    });
    expect(record.transpose).toBe(2);
    const score = alignedScore(sheet, record);
    const chords = ofType<ChordData>(score, "chord");
    expect(chords.slice(0, 4).map((c) => c.data.root)).toEqual([2, 9, 11, 7]);
    expect(score.meta.key?.tonic).toBe("D");
  });

  it("keeps UG's key, already sounding, through a capo", () => {
    // UG writes the sounding key with the capo applied (Wonderwall: "F#m" over
    // Em shapes, capo 2): here "D" over C shapes. Played at +2, it stays D.
    const capoSheet = parsedSheet(
      [
        { name: "Verse", lines: VERSE },
        { name: "Chorus", lines: CHORUS },
        { name: "Chorus", lines: [] },
      ],
      { key: "D", capo: 2 },
    );
    const features = synthFeatures(
      played([
        "D",
        "A",
        "Bm",
        "G",
        "D",
        "A",
        "G",
        "D",
        ...["Bm", "G", "D", "A"],
      ]),
    );
    const record = alignChords(capoSheet, features, {
      capo: 2,
      sheetHash: "h",
      settingsKey: "test",
    });
    expect(record.transpose).toBe(2);
    expect(alignedScore(capoSheet, record).meta.key?.tonic).toBe("D");
  });

  it("throws on a segment naming no chord of the sheet", () => {
    const record = aligned(synthFeatures(played(VERSE_PLAYED)));
    const other = parsedSheet([{ name: "Verse", lines: ["C"] }]);
    expect(() => alignedScore(other, record)).toThrow(/names no chord/);
  });
});

describe("fitsSheet", () => {
  // The markup `sheet` spells: the record's indices must name its chords.
  const chordLine = (line: string) =>
    line
      .split(" ")
      .map((c) => `[ch]${c}[/ch]`)
      .join(" ");
  const content = [
    "[Verse]",
    ...VERSE.map(chordLine),
    "[Chorus]",
    ...CHORUS.map(chordLine),
    "[Chorus]",
  ].join("\n");
  const record: AlignmentRecord = {
    ...aligned(synthFeatures(played(VERSE_PLAYED))),
    sheetHash: sheetHash(content),
  };

  it("fits the sheet it was made for, by the current aligner", () => {
    expect(fitsSheet(record, content)).toBe(true);
  });

  it("rejects a record made for another sheet", () => {
    expect(fitsSheet(record, `${content}\n[ch]Am[/ch]`)).toBe(false);
  });

  it("still fits when an earlier aligner made it: the version is not a condition", () => {
    expect(
      fitsSheet({ ...record, alignerVersion: ALIGNER_VERSION - 1 }, content),
    ).toBe(true);
  });

  it("rejects a record whose chord moved in today's parse", () => {
    const moved = record.segments.map((seg) =>
      seg.kind === "chord" ? { ...seg, symbol: "F#" } : seg,
    );
    expect(fitsSheet({ ...record, segments: moved }, content)).toBe(false);
  });

  it("rejects a record naming a chord this sheet no longer has", () => {
    const gone = record.segments.map((seg) =>
      seg.kind === "chord" ? { ...seg, line: 7 } : seg,
    );
    expect(fitsSheet({ ...record, segments: gone }, content)).toBe(false);
  });

  it("fits an old record that stored no symbols while its indices still name chords", () => {
    const bare = record.segments.map((seg) => {
      if (seg.kind !== "chord") return seg;
      const { symbol: _symbol, ...rest } = seg;
      return rest;
    });
    expect(fitsSheet({ ...record, segments: bare }, content)).toBe(true);
  });

  it("still fits when the match is weak: the score is not a condition", () => {
    expect(
      fitsSheet({ ...record, score: WEAK_MATCH_THRESHOLD - 0.01 }, content),
    ).toBe(true);
  });
});
