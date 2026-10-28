import { describe, expect, it } from "bun:test";
import { LET_IT_BE_VERSE } from "../testing";
import { HookpadHarmonyDocSchema, sectionFromHookpadDoc } from "./section";

const ID = "_NgbRXeYgQA";

/** The captured Hookpad document, optionally edited — for the shapes it does not happen to contain. */
function withDoc(edit: (doc: Record<string, unknown>) => void = () => {}) {
  const doc = JSON.parse(LET_IT_BE_VERSE.jsonData) as Record<string, unknown>;
  edit(doc);
  return doc;
}

function parse(doc: unknown) {
  return sectionFromHookpadDoc(ID, LET_IT_BE_VERSE.song, doc);
}

describe("sectionFromHookpadDoc — the captured Let It Be verse", () => {
  const section = parse(withDoc());

  it("keeps the id it was fetched by and the song title", () => {
    expect(section.id).toBe(ID);
    expect(section.song).toBe("Let It Be");
  });

  it("decodes all 12 chords, the leading rest included", () => {
    expect(section.chords).toHaveLength(12);
    expect(section.chords[0]).toMatchObject({
      isRest: true,
      beat: 1,
      duration: 4,
    });
    // I – V – vi – IV, two beats each, from beat 5.
    expect(
      section.chords.slice(1, 4).map((c) => [c.root, c.beat, c.duration]),
    ).toEqual([
      [1, 5, 2],
      [5, 7, 2],
      [6, 9, 2],
    ]);
    // ii7 in first inversion, on beat 12.
    expect(section.chords[5]).toMatchObject({ root: 2, type: 7, inversion: 1 });
  });

  it("reads the key, tempo, meter and end beat", () => {
    expect(section.keys).toEqual([{ beat: 1, scale: "major", tonic: "C" }]);
    expect(section.tempos[0]?.bpm).toBe(74);
    expect(section.meters).toEqual([{ beat: 1, numBeats: 4, beatUnit: 1 }]);
    expect(section.endBeat).toBe(21);
    expect(section.notes).toHaveLength(32);
  });

  it("pulls the video id out of the youtu.be share link, keeping the raw value", () => {
    expect(section.youtube.videoId).toBe("CGj85pVzRJs");
    expect(section.youtube.rawId).toBe(
      "https://youtu.be/CGj85pVzRJs?si=xzYBViA1tQ7Zyvkf",
    );
    expect(section.youtube.syncStart).toBeCloseTo(0.0614, 4);
    expect(section.youtube.syncEnd).toBeCloseTo(0.1145, 4);
  });

  it("drops the editor state around the musical content", () => {
    expect(Object.keys(section).sort()).toEqual([
      "chords",
      "endBeat",
      "id",
      "keys",
      "meters",
      "notes",
      "song",
      "tempos",
      "youtube",
    ]);
    expect(Object.keys(section.chords[0] ?? {})).not.toContain(
      "recordingEndBeat",
    );
    expect(Object.keys(section.youtube)).not.toContain("syncMode");
  });
});

describe("sectionFromHookpadDoc — shapes seen in other real sections", () => {
  it("accepts a custom borrowed scale given as semitone offsets", () => {
    const section = parse(
      withDoc((doc) => {
        const chords = doc.chords as Record<string, unknown>[];
        chords[1] = { ...chords[1], borrowed: [0, 2, 4, 5, 8, 9, 11] };
      }),
    );
    expect(section.chords[1]?.borrowed).toEqual([0, 2, 4, 5, 8, 9, 11]);
  });

  it("keeps a YouTube id that was never set as null (216 dump sections)", () => {
    const section = parse(
      withDoc((doc) => {
        doc.youtube = { ...(doc.youtube as object), id: null };
      }),
    );
    expect(section.youtube.rawId).toBeNull();
    expect(section.youtube.videoId).toBeNull();
  });

  it("gives a null videoId for a YouTube field it cannot read", () => {
    const section = parse(
      withDoc((doc) => {
        doc.youtube = { ...(doc.youtube as object), id: "" };
      }),
    );
    expect(section.youtube.videoId).toBeNull();
    expect(section.youtube.rawId).toBe("");
  });
});

describe("sectionFromHookpadDoc — a malformed document throws, never a partial section", () => {
  it("a chord field of the wrong type, named by its path", () => {
    const doc = withDoc((d) => {
      const chords = d.chords as Record<string, unknown>[];
      chords[3] = { ...chords[3], root: "six" };
    });
    expect(() => parse(doc)).toThrow(
      /TheoryTab section _NgbRXeYgQA document did not match the expected shape — chords\.3\.root: /,
    );
  });

  it("a value that is not a document at all", () => {
    expect(() => parse(null)).toThrow(/\(root\): /);
  });

  it("a missing section-level field", () => {
    const doc = withDoc((d) => {
      delete d.youtube;
    });
    expect(() => parse(doc)).toThrow(/youtube: /);
  });
});

describe("HookpadHarmonyDocSchema — a reader that never looks at the melody", () => {
  // The shape of dump document pJkmZPEjxqn: notes on a null beat, a tempo with no bpm.
  const broken = withDoc((doc) => {
    doc.notes = [
      { sd: "", octave: null, beat: null, duration: 1, isRest: false },
    ];
    doc.tempos = [{ beat: 1, bpm: null, swingFactor: 0, swingBeat: 0.5 }];
  });

  it("reads the harmony of a document whose melody is broken", () => {
    const parsed = HookpadHarmonyDocSchema.parse(broken);
    expect(parsed.chords).toHaveLength(12);
    expect(parsed.tempos[0]?.bpm).toBeNull();
    expect("notes" in parsed).toBe(false);
  });

  it("while the whole-document reader still refuses it, naming the melody", () => {
    expect(() => parse(broken)).toThrow(/notes/);
  });
});
