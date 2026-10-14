import { describe, expect, test } from "bun:test";
import type {
  ChordAnnotation,
  Note,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import {
  MusicXmlParseError,
  deriveMusicXmlSongMeta,
  parseMusicXml,
  parseMusicXmlDocument,
} from "./parse";

// --- Fixture builders --------------------------------------------------------

const DOCTYPE =
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
  '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">';

/** A one-part document; `measures` are the inner XML of each `<measure>`. */
function doc(
  measures: string[],
  opts: { header?: string; partName?: string } = {},
): string {
  return `${DOCTYPE}
<score-partwise version="4.0">
  ${opts.header ?? ""}
  <part-list><score-part id="P1"><part-name>${opts.partName ?? "Piano"}</part-name></score-part></part-list>
  <part id="P1">
    ${measures.map((m, i) => `<measure number="${i + 1}">${m}</measure>`).join("\n")}
  </part>
</score-partwise>`;
}

/** Divisions 4 (a sixteenth = 1), 4/4, C major. */
const ATTRS = `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>`;

function note(
  step: string,
  octave: number,
  duration: number,
  extra = "",
  { alter, chord }: { alter?: number; chord?: boolean } = {},
): string {
  return `<note>${chord ? "<chord/>" : ""}<pitch><step>${step}</step>${
    alter === undefined ? "" : `<alter>${alter}</alter>`
  }<octave>${octave}</octave></pitch><duration>${duration}</duration>${extra}</note>`;
}

const rest = (duration: number) =>
  `<note><rest/><duration>${duration}</duration></note>`;

function harmony(root: string, kind: string, extra = ""): string {
  return `<harmony><root><root-step>${root}</root-step></root><kind>${kind}</kind>${extra}</harmony>`;
}

const starts = (notes: Note[]) => notes.map((n) => n.start);
const chords = (s: { annotations: { type: string }[] }) =>
  s.annotations.filter((a): a is ChordAnnotation => a.type === "chord");

// --- Tests -------------------------------------------------------------------

describe("parseMusicXml: basics", () => {
  test("divisions → quarter-note beats, pitch + spelling, title, key, time", () => {
    const xml = doc(
      [
        ATTRS +
          note("C", 4, 4) +
          note("F", 4, 2, "", { alter: 1 }) +
          note("B", 3, 2, "", { alter: -1 }) +
          rest(8),
      ],
      { header: "<work><work-title>Groove</work-title></work>" },
    );
    const s = parseMusicXml(xml);
    expect(s.meta.title).toBe("Groove");
    expect(s.meta.key).toEqual({ tonic: "C", mode: "major" });
    expect(s.timeSigMap).toEqual([{ beat: 0, numerator: 4, denominator: 4 }]);
    expect(s.tempoMap).toEqual([{ beat: 0, bpm: 120 }]);
    expect(s.notes.map((n) => [n.pitch, n.start, n.duration])).toEqual([
      [60, 0, 1],
      [66, 1, 0.5],
      [58, 1.5, 0.5],
    ]);
    expect(s.notes[1]!.spelling).toEqual({ step: "F", alter: 1, octave: 4 });
    expect(s.notes[2]!.spelling).toEqual({ step: "B", alter: -1, octave: 3 });
    expect(s.tracks).toEqual([{ id: "P1", name: "Piano" }]);
  });

  test("<chord/> shares the previous onset; <backup>/<forward> move the cursor", () => {
    const xml = doc([
      ATTRS +
        note("C", 4, 8) +
        note("E", 4, 8, "", { chord: true }) +
        note("G", 4, 8, "<voice>1</voice>") +
        "<backup><duration>16</duration></backup>" +
        "<forward><duration>4</duration></forward>" +
        note("C", 3, 4, "<voice>2</voice>"),
    ]);
    const s = parseMusicXml(xml);
    const byPitch = new Map(s.notes.map((n) => [n.pitch, n]));
    expect(byPitch.get(60)!.start).toBe(0);
    expect(byPitch.get(64)!.start).toBe(0);
    expect(byPitch.get(67)!.start).toBe(2);
    expect(byPitch.get(67)!.voice).toBe(1);
    expect(byPitch.get(48)!.start).toBe(1);
    expect(byPitch.get(48)!.voice).toBe(2);
  });

  test("key mode and flats", () => {
    const xml = doc([
      `<attributes><divisions>1</divisions><key><fifths>-1</fifths><mode>minor</mode></key></attributes>` +
        note("D", 4, 4),
    ]);
    expect(parseMusicXml(xml).meta.key).toEqual({ tonic: "D", mode: "minor" });
  });

  test("a pickup (implicit first measure) sets pickupBeats and shifts the bars", () => {
    const xml = `${DOCTYPE}<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1">
      <measure number="0" implicit="yes">${ATTRS}${note("G", 4, 4)}</measure>
      <measure number="1">${note("C", 5, 16)}</measure></part></score-partwise>`;
    const s = parseMusicXml(xml);
    expect(s.meta.pickupBeats).toBe(1);
    expect(starts(s.notes)).toEqual([0, 1]);
  });

  test("an under-full measure still takes a whole bar", () => {
    const s = parseMusicXml(doc([ATTRS + note("C", 4, 4), note("D", 4, 4)]));
    expect(starts(s.notes)).toEqual([0, 4]);
  });

  test("dynamics set the velocity of the notes that follow", () => {
    const xml = doc([
      ATTRS +
        note("C", 4, 4) +
        `<direction><direction-type><dynamics><p/></dynamics></direction-type></direction>` +
        note("D", 4, 4) +
        note("E", 4, 4, "") +
        `<note dynamics="111.11"><pitch><step>F</step><octave>4</octave></pitch><duration>4</duration></note>`,
      note("G", 4, 16),
    ]);
    expect(parseMusicXml(xml).notes.map((n) => n.velocity)).toEqual([
      80, 49, 49, 100, 49,
    ]);
  });

  test("grace notes are skipped; cue notes take time but do not sound", () => {
    const xml = doc([
      ATTRS +
        `<note><grace/><pitch><step>B</step><octave>3</octave></pitch></note>` +
        `<note><cue/><pitch><step>A</step><octave>3</octave></pitch><duration>4</duration></note>` +
        note("C", 4, 4),
    ]);
    const s = parseMusicXml(xml);
    expect(s.notes.map((n) => [n.pitch, n.start])).toEqual([[60, 1]]);
  });
});

describe("parseMusicXml: ties", () => {
  test("a tie across a barline merges into one note", () => {
    const xml = doc([
      ATTRS +
        rest(8) +
        note(
          "C",
          4,
          8,
          `<tie type="start"/><notations><tied type="start"/></notations>`,
        ),
      note("C", 4, 4, `<tie type="stop"/>`) + rest(12),
    ]);
    const s = parseMusicXml(xml);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]!.start).toBe(2);
    expect(s.notes[0]!.duration).toBe(3);
  });

  test("a chain of ties (stop + start) merges all segments", () => {
    const xml = doc([
      ATTRS +
        note("E", 4, 4, `<tie type="start"/>`) +
        note("E", 4, 4, `<tie type="stop"/><tie type="start"/>`) +
        note("E", 4, 4, `<tie type="stop"/>`) +
        note("E", 4, 4),
    ]);
    const s = parseMusicXml(xml);
    expect(s.notes.map((n) => [n.start, n.duration])).toEqual([
      [0, 3],
      [3, 1],
    ]);
  });
});

describe("parseMusicXml: two staves", () => {
  test("a grand staff becomes an RH and an LH track", () => {
    const xml = doc([
      `<attributes><divisions>1</divisions><staves>2</staves></attributes>` +
        note("C", 5, 4, "<voice>1</voice><staff>1</staff>") +
        "<backup><duration>4</duration></backup>" +
        note("C", 3, 2, "<voice>5</voice><staff>2</staff>") +
        note("G", 2, 2, "<voice>5</voice><staff>2</staff>"),
    ]);
    const s = parseMusicXml(xml);
    expect(s.tracks).toEqual([
      { id: "P1-s1", name: "Piano RH" },
      { id: "P1-s2", name: "Piano LH" },
    ]);
    expect(
      s.notes.filter((n) => n.track === "P1-s2").map((n) => [n.pitch, n.start]),
    ).toEqual([
      [48, 0],
      [43, 2],
    ]);
    expect(s.notes.find((n) => n.pitch === 72)!.track).toBe("P1-s1");
  });

  test("multiple parts keep their own tracks and GM program", () => {
    const xml = `${DOCTYPE}<score-partwise><part-list>
      <score-part id="P1"><part-name>Flute</part-name><midi-instrument id="I1"><midi-program>74</midi-program></midi-instrument></score-part>
      <score-part id="P2"><part-name>Bass</part-name></score-part></part-list>
      <part id="P1"><measure number="1">${ATTRS}${note("A", 5, 16)}</measure></part>
      <part id="P2"><measure number="1">${ATTRS}${note("A", 2, 16)}</measure></part></score-partwise>`;
    const s = parseMusicXml(xml);
    expect(s.tracks).toEqual([
      { id: "P1", name: "Flute", gmProgram: 73 },
      { id: "P2", name: "Bass" },
    ]);
  });
});

describe("parseMusicXml: repeats and voltas", () => {
  const fwd = `<barline location="left"><repeat direction="forward"/></barline>`;
  const back = (times?: number) =>
    `<barline location="right"><repeat direction="backward"${times ? ` times="${times}"` : ""}/></barline>`;
  const endStart = (n: string) =>
    `<barline location="left"><ending number="${n}" type="start"/></barline>`;
  const endStop = (n: string, type = "stop") =>
    `<barline location="right"><ending number="${n}" type="${type}"/></barline>`;
  const whole = (step: string) => note(step, 4, 16);
  const order = (xml: string) =>
    parseMusicXml(xml).notes.map((n) => n.spelling!.step);

  test("a simple repeat plays the section twice", () => {
    expect(
      order(
        doc([
          ATTRS + whole("C"),
          fwd + whole("D"),
          whole("E") + back(),
          whole("F"),
        ]),
      ),
    ).toEqual(["C", "D", "E", "D", "E", "F"]);
  });

  test("a repeat with no forward barline returns to the start", () => {
    expect(
      order(doc([ATTRS + whole("C"), whole("D") + back(), whole("E")])),
    ).toEqual(["C", "D", "C", "D", "E"]);
  });

  test("times=3 plays three times", () => {
    expect(order(doc([ATTRS + fwd + whole("C") + back(3)]))).toEqual([
      "C",
      "C",
      "C",
    ]);
  });

  test("first and second endings", () => {
    const xml = doc([
      ATTRS + fwd + whole("C"),
      endStart("1") + whole("D") + back() + endStop("1"),
      endStart("2") + whole("E") + endStop("2", "discontinue"),
      whole("F"),
    ]);
    expect(order(xml)).toEqual(["C", "D", "C", "E", "F"]);
  });

  test("a multi-measure volta and a later repeat section", () => {
    const xml = doc([
      ATTRS + whole("C"),
      endStart("1") + whole("D"),
      whole("E") + back() + endStop("1"),
      endStart("2") + whole("F") + endStop("2"),
      fwd + whole("G"),
      whole("A") + back(),
    ]);
    expect(order(xml)).toEqual(["C", "D", "E", "C", "F", "G", "A", "G", "A"]);
  });

  test("unrolled time is cumulative and a tie still merges inside a repeat", () => {
    const xml = doc([
      ATTRS +
        fwd +
        note("C", 4, 8, `<tie type="start"/>`) +
        note("C", 4, 8, `<tie type="stop"/>`) +
        back(),
    ]);
    const s = parseMusicXml(xml);
    expect(s.notes.map((n) => [n.start, n.duration])).toEqual([
      [0, 4],
      [4, 4],
    ]);
  });

  test("an ending that never stops throws", () => {
    expect(() =>
      parseMusicXml(doc([ATTRS + endStart("1") + whole("C")])),
    ).toThrow(MusicXmlParseError);
  });
});

describe("parseMusicXml: harmony", () => {
  test("chord symbols become authored chord annotations spanning to the next", () => {
    const xml = doc([
      ATTRS +
        harmony("D", "minor-ninth") +
        note("D", 4, 8) +
        harmony("C", "major", `<bass><bass-step>E</bass-step></bass>`) +
        note("E", 4, 8),
      harmony("F", "major-seventh") + note("F", 4, 16),
    ]);
    const cs = chords(parseMusicXml(xml));
    expect(cs.map((c) => [c.data.symbol, c.start, c.end, c.source])).toEqual([
      ["Dm9", 0, 2, "authored"],
      ["C/E", 2, 4, "authored"],
      ["Fmaj7", 4, 8, "authored"],
    ]);
    expect(cs[1]!.data.bass).toBe(4);
  });

  test("root alter, degrees and N.C.", () => {
    const xml = doc([
      ATTRS +
        `<harmony><root><root-step>B</root-step><root-alter>-1</root-alter></root><kind>dominant</kind>` +
        `<degree><degree-value>9</degree-value><degree-alter>-1</degree-alter><degree-type>add</degree-type></degree></harmony>` +
        note("B", 3, 8, "", { alter: -1 }) +
        `<harmony><root><root-step>C</root-step></root><kind>none</kind></harmony>` +
        note("C", 4, 8),
    ]);
    const cs = chords(parseMusicXml(xml));
    expect(cs).toHaveLength(1);
    expect(cs[0]!.data.symbol).toBe("Bb7(♭9)");
    expect(cs[0]!.end).toBe(2); // N.C. ends it
  });

  test("an <offset> places the chord inside the beat", () => {
    const xml = doc([
      ATTRS +
        note("C", 4, 16) +
        harmony("G", "dominant", "<offset>-8</offset>"),
    ]);
    expect(chords(parseMusicXml(xml))[0]!.start).toBe(2);
  });

  test("every symbol kind parses", () => {
    const kinds = [
      "major",
      "minor",
      "augmented",
      "diminished",
      "dominant",
      "major-seventh",
      "minor-seventh",
      "diminished-seventh",
      "augmented-seventh",
      "half-diminished",
      "major-minor",
      "major-sixth",
      "minor-sixth",
      "dominant-ninth",
      "major-ninth",
      "minor-ninth",
      "dominant-11th",
      "major-11th",
      "minor-11th",
      "dominant-13th",
      "major-13th",
      "minor-13th",
      "suspended-second",
      "suspended-fourth",
      "power",
    ];
    for (const kind of kinds) {
      const s = parseMusicXml(
        doc([ATTRS + harmony("C", kind) + note("C", 4, 16)]),
      );
      expect(chords(s)).toHaveLength(1);
    }
  });

  test("a functional chord kind throws, naming the measure", () => {
    const xml = doc([
      ATTRS + note("C", 4, 16),
      harmony("C", "Neapolitan") + note("C", 4, 16),
    ]);
    expect(() => parseMusicXml(xml)).toThrow(
      /<kind> in measure 2, part P1: unsupported chord kind "Neapolitan"/,
    );
  });
});

describe("parseMusicXml: tempo", () => {
  test("<sound tempo> → tempo map, collapsed across repeats", () => {
    const xml = doc([
      ATTRS + `<direction><sound tempo="110"/></direction>` + note("C", 4, 16),
      `<direction><sound tempo="90"/></direction>` + note("D", 4, 16),
    ]);
    expect(parseMusicXml(xml).tempoMap).toEqual([
      { beat: 0, bpm: 110 },
      { beat: 4, bpm: 90 },
    ]);
  });

  test("a metronome mark is the tempo when no <sound tempo> is given", () => {
    const xml = doc([
      ATTRS +
        `<direction><direction-type><metronome><beat-unit>quarter</beat-unit><beat-unit-dot/><per-minute>60</per-minute></metronome></direction-type></direction>` +
        note("C", 4, 16),
    ]);
    expect(parseMusicXml(xml).tempoMap).toEqual([{ beat: 0, bpm: 90 }]);
  });

  test("<sound tempo> wins over the metronome mark of the same direction", () => {
    const xml = doc([
      ATTRS +
        `<direction><direction-type><metronome><beat-unit>half</beat-unit><per-minute>50</per-minute></metronome></direction-type><sound tempo="110"/></direction>` +
        note("C", 4, 16),
    ]);
    expect(parseMusicXml(xml).tempoMap).toEqual([{ beat: 0, bpm: 110 }]);
  });
});

describe("parseMusicXml: swing", () => {
  test("MusicXML 4 <swing> → meta.swing", () => {
    const xml = doc([
      ATTRS +
        `<direction><sound tempo="110"><swing><first>2</first><second>1</second><swing-type>16th</swing-type></swing></sound></direction>` +
        note("C", 4, 16),
    ]);
    expect(parseMusicXml(xml).meta.swing).toEqual({ unit: 16, ratio: 2 });
  });

  test("swing-type defaults to eighths; straight is no swing", () => {
    const swung = doc([
      ATTRS +
        `<sound><swing><first>3</first><second>2</second></swing></sound>` +
        note("C", 4, 16),
    ]);
    expect(parseMusicXml(swung).meta.swing).toEqual({ unit: 8, ratio: 1.5 });
    const straight = doc([
      ATTRS + `<sound><swing><straight/></swing></sound>` + note("C", 4, 16),
    ]);
    expect(parseMusicXml(straight).meta.swing).toBeUndefined();
  });

  test("words 'Swung 16ths' are read when no <swing> element exists", () => {
    const words = (w: string) =>
      doc([
        ATTRS +
          `<direction><direction-type><words>${w}</words></direction-type></direction>` +
          note("C", 4, 16),
      ]);
    expect(parseMusicXml(words("Swung 16ths")).meta.swing).toEqual({
      unit: 16,
      ratio: 2,
    });
    expect(parseMusicXml(words("Swing")).meta.swing).toEqual({
      unit: 8,
      ratio: 2,
    });
    // Anything looser is not trusted.
    expect(parseMusicXml(words("Medium swing")).meta.swing).toBeUndefined();
  });

  test("a change between straight and swing throws", () => {
    const xml = doc([
      ATTRS + `<sound><swing><straight/></swing></sound>` + note("C", 4, 16),
      `<sound><swing><first>2</first><second>1</second></swing></sound>` +
        note("C", 4, 16),
    ]);
    expect(() => parseMusicXml(xml)).toThrow(MusicXmlParseError);
  });
});

describe("parseMusicXml: failures are loud", () => {
  test("malformed XML", () => {
    expect(() => parseMusicXml("<score-partwise><part>")).toThrow(
      /not well-formed XML/,
    );
  });

  test("timewise documents", () => {
    expect(() =>
      parseMusicXml(`<score-timewise><measure number="1"/></score-timewise>`),
    ).toThrow(/only score-partwise/);
  });

  test("a duration before divisions", () => {
    expect(() => parseMusicXml(doc([note("C", 4, 4)]))).toThrow(
      /before any <divisions>/,
    );
  });

  test("a backup past the measure start", () => {
    expect(() =>
      parseMusicXml(
        doc([
          ATTRS + note("C", 4, 4) + "<backup><duration>8</duration></backup>",
        ]),
      ),
    ).toThrow(MusicXmlParseError);
  });

  test("D.S./D.C. jumps", () => {
    expect(() =>
      parseMusicXml(doc([ATTRS + note("C", 4, 16) + `<sound dacapo="yes"/>`])),
    ).toThrow(/dacapo/);
  });

  test("the error names element, measure and part", () => {
    try {
      parseMusicXml(
        doc([
          ATTRS + note("C", 4, 16),
          `<note><pitch><step>H</step><octave>4</octave></pitch><duration>16</duration></note>`,
        ]),
      );
      throw new Error("expected a throw");
    } catch (err) {
      if (!(err instanceof MusicXmlParseError)) throw err;
      expect(err.element).toBe("step");
      expect(err.measure).toBe("2");
      expect(err.part).toBe("P1");
    }
  });

  test("a non-string raw", () => {
    expect(() => parseMusicXml(new ArrayBuffer(4))).toThrow(/document text/);
  });
});

describe("deriveMusicXmlSongMeta", () => {
  test("title, composer, duration from the tempo map", () => {
    const xml = doc([ATTRS + `<sound tempo="60"/>` + note("C", 4, 16)], {
      header: `<movement-title>Étude</movement-title><identification><creator type="composer">Anon</creator></identification>`,
    });
    expect(deriveMusicXmlSongMeta(xml)).toEqual({
      title: "Étude",
      composer: "Anon",
      durationSec: 4,
      endBeat: 4,
    });
    expect(parseMusicXmlDocument(xml).composer).toBe("Anon");
  });
});
