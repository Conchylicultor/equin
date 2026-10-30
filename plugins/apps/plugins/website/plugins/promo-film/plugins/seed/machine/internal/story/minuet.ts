import { Midi } from "@tonejs/midi";

// The practice file the film's agent makes: the first eight bars of the Minuet
// in G (BWV Anh. 114, from the Notebook for Anna Magdalena Bach — public
// domain), both hands, as note data — generated into a `.mid` at seed time the
// way Sonata's starters are, so no binary sits in the repo. The same data
// renders the script the transcript shows the agent writing, so the
// script and the file it made cannot disagree.

/** One note: MIDI number, start and length in beats (a crotchet is 1). */
export interface MinuetNote {
  midi: number;
  beat: number;
  beats: number;
}

export const MINUET = {
  title: "Minuet in G",
  fileName: "minuet-in-g.mid",
  bpm: 100,
  timeSignature: [3, 4] as const,
  bars: 8,
} as const;

const n = (midi: number, beat: number, beats: number): MinuetNote => ({
  midi,
  beat,
  beats,
});

// D5 74, E5 76, F#5 78, G5 79, C5 72, B4 71, A4 69, G4 67, F#4 66.
export const RIGHT_HAND: readonly MinuetNote[] = [
  // 1
  n(74, 0, 1),
  n(67, 1, 0.5),
  n(69, 1.5, 0.5),
  n(71, 2, 0.5),
  n(72, 2.5, 0.5),
  // 2
  n(74, 3, 1),
  n(67, 4, 1),
  n(67, 5, 1),
  // 3
  n(76, 6, 1),
  n(72, 7, 0.5),
  n(74, 7.5, 0.5),
  n(76, 8, 0.5),
  n(78, 8.5, 0.5),
  // 4
  n(79, 9, 1),
  n(67, 10, 1),
  n(67, 11, 1),
  // 5
  n(72, 12, 1),
  n(74, 13, 0.5),
  n(72, 13.5, 0.5),
  n(71, 14, 0.5),
  n(69, 14.5, 0.5),
  // 6
  n(71, 15, 1),
  n(72, 16, 0.5),
  n(71, 16.5, 0.5),
  n(69, 17, 0.5),
  n(67, 17.5, 0.5),
  // 7
  n(66, 18, 1),
  n(67, 19, 0.5),
  n(69, 19.5, 0.5),
  n(71, 20, 0.5),
  n(67, 20.5, 0.5),
  // 8
  n(69, 21, 3),
];

// G3 55, A3 57, B3 59, C4 60, D4 62, D3 50, F#3 54.
export const LEFT_HAND: readonly MinuetNote[] = [
  n(55, 0, 2),
  n(57, 2, 1),
  n(59, 3, 3),
  n(60, 6, 3),
  n(59, 9, 3),
  n(57, 12, 3),
  n(55, 15, 3),
  n(62, 18, 2),
  n(59, 20, 1),
  n(62, 21, 1),
  n(50, 22, 1),
  n(54, 23, 1),
];

/** The practice file's bytes: two tracks (right, left), 3/4 at {@link MINUET}'s tempo. */
export function minuetMidiBytes(): Uint8Array {
  const midi = new Midi();
  midi.header.name = MINUET.title;
  // Tempo before notes: `addNote` converts seconds to ticks through it.
  midi.header.setTempo(MINUET.bpm);
  midi.header.timeSignatures.push({
    ticks: 0,
    timeSignature: [...MINUET.timeSignature],
  });
  midi.header.update();
  const secondsPerBeat = 60 / MINUET.bpm;
  for (const [name, notes] of [
    ["Right hand", RIGHT_HAND],
    ["Left hand", LEFT_HAND],
  ] as const) {
    const track = midi.addTrack();
    track.name = name;
    track.instrument.number = 0;
    for (const note of notes)
      track.addNote({
        midi: note.midi,
        time: note.beat * secondsPerBeat,
        duration: note.beats * secondsPerBeat,
        velocity: name === "Right hand" ? 0.75 : 0.55,
      });
  }
  return midi.toArray();
}

const jsNotes = (notes: readonly MinuetNote[]) =>
  notes.map((x) => `  [${x.midi}, ${x.beat}, ${x.beats}],`).join("\n");

/** The script the transcript shows the agent writing — it makes exactly {@link minuetMidiBytes}' music. */
export function minuetScript(): string {
  return [
    "// Minuet in G (BWV Anh. 114), bars 1-8, both hands, as a practice MIDI file.",
    'import { writeFileSync } from "node:fs";',
    'import midiPkg from "@tonejs/midi";',
    "",
    "const { Midi } = midiPkg;",
    `const BPM = ${MINUET.bpm};`,
    "const beat = 60 / BPM; // seconds per crotchet",
    "",
    "// [midi note, start beat, length in beats]",
    "const RIGHT = [",
    jsNotes(RIGHT_HAND),
    "];",
    "const LEFT = [",
    jsNotes(LEFT_HAND),
    "];",
    "",
    "const midi = new Midi();",
    `midi.header.name = "${MINUET.title}";`,
    "midi.header.setTempo(BPM);",
    "midi.header.timeSignatures.push({ ticks: 0, timeSignature: [3, 4] });",
    "midi.header.update();",
    "",
    "for (const [name, notes, velocity] of [",
    '  ["Right hand", RIGHT, 0.75],',
    '  ["Left hand", LEFT, 0.55],',
    "]) {",
    "  const track = midi.addTrack();",
    "  track.name = name;",
    "  for (const [note, start, length] of notes)",
    "    track.addNote({ midi: note, time: start * beat, duration: length * beat, velocity });",
    "}",
    "",
    `writeFileSync("practice/${MINUET.fileName}", midi.toArray());`,
    "console.log(",
    `  \`Wrote practice/${MINUET.fileName}: \${RIGHT.length + LEFT.length} notes, ${MINUET.bars} bars, \${BPM} bpm\`,`,
    ");",
    "",
  ].join("\n");
}
