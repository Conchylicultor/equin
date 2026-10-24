// ─── hookpadChordSound against Sheet Sage, on the whole dump ──────────────────
//
//   ./equin run plugins/integrations/plugins/hooktheory/scripts/hookpad-sound-golden.ts \
//     --raw <Hooktheory_Raw.json.gz> --processed <Hooktheory.json.gz> [--emit-fixtures]
//
// Sheet Sage published two files for the same 26k TheoryTab sections: the raw
// Hookpad documents, and its own processed reading of them (every chord as a
// root pitch class plus root-position intervals). `hookpadChordSound` is a port
// of the code that made the processed file, so reading every raw chord with it
// must give the processed chord back. This script checks exactly that, chord
// by chord, and prints every class of disagreement with examples.
//
// Download both files (commit pinned below) to a scratch directory first:
//   https://github.com/chrisdonahue/sheetsage-data/raw/<commit>/hooktheory/Hooktheory.json.gz
//   https://github.com/chrisdonahue/sheetsage-data/raw/<commit>/hooktheory/Hooktheory_Raw.json.gz
//
// The processed file (~309 MB of JSON) is read with one JSON.parse. The raw
// file is ~1.5 GB, beyond one string, so it is streamed one section at a time.
// A full run takes about 3 minutes.
//
// --emit-fixtures rewrites `core/testing/hookpad-sound.fixtures.ts`: one
// chord per distinct combination of the fields that change a sound, with Sheet
// Sage's answer, which `hookpad-sound.test.ts` replays on every test run.
//
// Results of the last run: research/2026-09-17-integrations-hookpad-chord-sound.md.

import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, createGunzip } from "node:zlib";
import { JSONParser } from "@streamparser/json";
import { z } from "zod";
import { formatSource } from "@plugins/framework/plugins/tooling/plugins/format/core";
// The internal modules, not the `core` barrel: the barrel also carries the
// endpoint contracts, which need DOM types this node script's program lacks.
import {
  HOOKPAD_MODE_OFFSETS,
  hookpadChordSound,
  hookpadTonicPc,
  type HookpadChordReading,
} from "../core/internal/hookpad-sound";
import type {
  HookpadChord,
  HookpadKey,
  TheorytabSection,
} from "../core/internal/schemas";
import { sectionFromHookpadDoc } from "../core/internal/section";
import { hookpadKeyAt } from "../core/internal/key-at";
import { encodeFixture } from "../core/internal/hookpad-sound.fixture-format";

/** `github.com/chrisdonahue/sheetsage-data`, commit 06113c04b109a2f27517b0399ff47550099f2466, `hooktheory/`. */
const PINNED_SHA256 = {
  processed: "917b7cd58f5f4e07d6c36acf7bfad958c99ee05472dab3555399141094698e0c",
  raw: "716af2979f060400c302ab098dd45d9f8c5fe4d4b3b1fe61c478dd9bdf041634",
};

const EXAMPLES_PER_CLASS = 3;
const BEAT_EPS = 1e-6;

// ─── args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name: string): string {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (value === undefined) {
    throw new Error(
      `${name} <path> is required. Usage: hookpad-sound-golden.ts --raw <Hooktheory_Raw.json.gz> --processed <Hooktheory.json.gz> [--emit-fixtures]`,
    );
  }
  return value;
}
const rawPath = flag("--raw");
const processedPath = flag("--processed");
const emitFixtures = argv.includes("--emit-fixtures");

// ─── pinned inputs ───────────────────────────────────────────────────────────

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

for (const [which, path] of [
  ["raw", rawPath],
  ["processed", processedPath],
] as const) {
  const actual = await sha256(path);
  if (actual !== PINNED_SHA256[which]) {
    throw new Error(
      `${which} file ${path} has sha256 ${actual}, expected the pinned ${PINNED_SHA256[which]}`,
    );
  }
}
console.log("Both files match their pinned sha256.");

// ─── the processed file ──────────────────────────────────────────────────────

const ProcessedChordSchema = z.object({
  onset: z.number(),
  offset: z.number(),
  root_pitch_class: z.number(),
  root_position_intervals: z.array(z.number()),
  inversion: z.number(),
});
const ProcessedKeySchema = z.object({
  beat: z.number(),
  tonic_pitch_class: z.number(),
  scale_degree_intervals: z.array(z.number()),
});
const ProcessedSectionSchema = z.object({
  tags: z.array(z.string()),
  annotations: z.object({
    num_beats: z.number(),
    keys: z.array(ProcessedKeySchema),
    harmony: z.array(ProcessedChordSchema).nullable(),
  }),
});
type ProcessedSection = z.infer<typeof ProcessedSectionSchema>;
type ProcessedChord = z.infer<typeof ProcessedChordSchema>;

const processed = z
  .record(z.string(), ProcessedSectionSchema)
  .parse(JSON.parse(gunzipSync(readFileSync(processedPath)).toString("utf8")));
const processedIds = new Set(Object.keys(processed));
console.log(`Processed: ${processedIds.size} sections.`);

// ─── tallies ─────────────────────────────────────────────────────────────────

type Tally = { count: number; examples: unknown[] };
function tally(
  table: Map<string, Tally>,
  key: string,
  example: () => unknown,
  by = 1,
) {
  let entry = table.get(key);
  if (entry === undefined) {
    entry = { count: 0, examples: [] };
    table.set(key, entry);
  }
  entry.count += by;
  if (entry.examples.length < EXAMPLES_PER_CLASS)
    entry.examples.push(example());
}
function printTable(title: string, table: Map<string, Tally>) {
  console.log(`\n## ${title}`);
  if (table.size === 0) console.log("(none)");
  for (const [key, { count, examples }] of [...table].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    console.log(`\n- ${key}: ${count}`);
    for (const e of examples) console.log(`    ${JSON.stringify(e)}`);
  }
}

const counts = {
  rawEntries: 0,
  noDocument: 0,
  sections: 0,
  rawNonRestChords: 0,
  processedChords: 0,
  paired: 0,
  agree: 0,
  keysCompared: 0,
  keysAgree: 0,
};
const chordClasses = new Map<string, Tally>();
const droppedSections = new Map<string, Tally>();
const sectionClasses = new Map<string, Tally>();
const keyClasses = new Map<string, Tally>();
const overrunWithHarmony = new Map<string, Tally>();
const fixtures = new Map<string, string>();

// ─── helpers ─────────────────────────────────────────────────────────────────

/** The key in force at `beat` (the shared rule, `hookpadKeyAt`); a chord before every key is a broken assumption here. */
function keyAt(id: string, keys: HookpadKey[], beat: number): HookpadKey {
  const found = hookpadKeyAt(keys, beat);
  if (found.kind === "before-first-key")
    throw new Error(`section ${id}: no key in force at beat ${beat}`);
  return found.key;
}

/** Sheet Sage's `will_sound`. */
function willSound(c: HookpadChord): boolean {
  return c.beat >= 1 && c.duration > 1e-8 && !c.isRest;
}

function borrowedKind(b: HookpadChord["borrowed"]): string {
  if (b === null || b === "") return "none";
  return Array.isArray(b) ? "custom" : b;
}

function chordFields(c: HookpadChord) {
  return {
    root: c.root,
    beat: c.beat,
    type: c.type,
    inversion: c.inversion,
    applied: c.applied,
    borrowed: c.borrowed,
    adds: c.adds,
    omits: c.omits,
    alterations: c.alterations,
    suspensions: c.suspensions,
  };
}

function theirs(p: ProcessedChord) {
  return {
    rootPc: p.root_pitch_class,
    intervals: p.root_position_intervals,
    inversion: p.inversion,
  };
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ─── one section ─────────────────────────────────────────────────────────────

const RawEntrySchema = z.object({
  json: z.unknown(),
  json_api: z.object({ song: z.string() }).nullable().optional(),
});

function compareSection(id: string, entry: z.infer<typeof RawEntrySchema>) {
  counts.rawEntries++;
  const p: ProcessedSection | undefined = processed[id];
  if (entry.json === null || entry.json === undefined) {
    counts.noDocument++;
    tally(
      sectionClasses,
      `raw entry without a document (${p ? "processed HAS it" : "processed lacks it too"})`,
      () => id,
    );
    return;
  }
  processedIds.delete(id);
  if (p === undefined) {
    tally(sectionClasses, "raw document with no processed section", () => id);
    return;
  }
  let section: TheorytabSection;
  try {
    section = sectionFromHookpadDoc(id, entry.json_api?.song ?? "", entry.json);
  } catch (err) {
    // A document the section schema refuses is a finding about the schema, so
    // it is counted by the fields it names (indices elided) — not a crash.
    if (
      !(err instanceof Error) ||
      !err.message.includes("did not match the expected shape")
    )
      throw err;
    const fields = [
      ...new Set(
        [...err.message.matchAll(/(?:— |; )([\w.]+): ([^;(]+)/g)].map(
          (m) =>
            `${(m[1] ?? "").replace(/\.\d+\./g, ".N.")}: ${(m[2] ?? "").trim()}`,
        ),
      ),
    ].sort();
    tally(
      sectionClasses,
      `document refused by the section schema — ${fields.join("; ")}`,
      () => ({ id, message: err.message.slice(0, 300) }),
    );
    return;
  }
  counts.sections++;

  // Keys, 0-based. (The reference's lead-sheet builder also drops a key equal
  // to the previous one and trims changes at or after the last beat; the
  // processed file does neither, so neither does this comparison.)
  const ourKeys: { beat: number; tonicPc: number; steps: number[] }[] = [];
  for (const k of section.keys) {
    const offsets = HOOKPAD_MODE_OFFSETS[k.scale];
    const key = {
      beat: k.beat - 1,
      tonicPc: hookpadTonicPc(k.tonic),
      steps: offsets.slice(1).map((o, i) => o - (offsets[i] ?? 0)),
    };
    const prev = ourKeys.at(-1);
    const repeat =
      prev !== undefined &&
      prev.tonicPc === key.tonicPc &&
      sameNumbers(prev.steps, key.steps);
    if (repeat)
      tally(keyClasses, "(info) raw key repeats the previous one", () => ({
        id,
        beat: k.beat,
        endBeat: section.endBeat,
      }));
    ourKeys.push(key);
  }
  const theirKeys = p.annotations.keys.map((k) => ({
    beat: k.beat,
    tonicPc: k.tonic_pitch_class,
    steps: k.scale_degree_intervals,
  }));
  counts.keysCompared++;
  const keysEqual =
    ourKeys.length === theirKeys.length &&
    ourKeys.every((k, i) => {
      const t = theirKeys[i];
      return (
        t !== undefined &&
        Math.abs(k.beat - t.beat) < BEAT_EPS &&
        k.tonicPc === t.tonicPc &&
        sameNumbers(k.steps, t.steps)
      );
    });
  if (keysEqual) counts.keysAgree++;
  else
    tally(keyClasses, "key map differs", () => ({
      id,
      endBeat: section.endBeat,
      numBeats: p.annotations.num_beats,
      raw: section.keys,
      ours: ourKeys,
      theirs: theirKeys,
    }));

  // Chords.
  const nonRest = section.chords.filter((c) => !c.isRest);
  counts.rawNonRestChords += nonRest.length;
  const harmony = p.annotations.harmony ?? [];
  counts.processedChords += harmony.length;
  const sounding = section.chords.filter(willSound);
  const readings: HookpadChordReading[] = section.chords.map((c) => {
    return hookpadChordSound(c, keyAt(id, section.keys, c.beat));
  });
  const firstUnreadable = readings.find((r) => r.kind === "unreadable");
  const overrun = sounding.find(
    (c) => c.beat + c.duration > section.endBeat + BEAT_EPS,
  );

  if (harmony.length === 0 && nonRest.length > 0) {
    let why: string;
    if (firstUnreadable?.kind === "unreadable")
      why = `a chord breaks rule "${firstUnreadable.rule}"`;
    else if (overrun)
      why = "no chord is unreadable; a chord ends after endBeat";
    else why = "reference dropped it, we read it";
    tally(
      droppedSections,
      why,
      () => ({
        id,
        nonRestChords: nonRest.length,
        detail:
          firstUnreadable?.kind === "unreadable"
            ? firstUnreadable.detail
            : undefined,
        endBeat: section.endBeat,
        overrun: overrun ? chordFields(overrun) : undefined,
        tags: p.tags,
      }),
      1,
    );
    tally(droppedSections, `  (chords in "${why}")`, () => id, nonRest.length);
    return;
  }
  if (overrun) {
    tally(
      overrunWithHarmony,
      "reference kept harmony although a chord ends after endBeat",
      () => ({ id, endBeat: section.endBeat, chord: chordFields(overrun) }),
    );
  }
  if (firstUnreadable?.kind === "unreadable") {
    tally(
      sectionClasses,
      `reference kept harmony, we find rule "${firstUnreadable.rule}" broken`,
      () => ({ id, detail: firstUnreadable.detail }),
    );
  }
  if (harmony.length !== sounding.length) {
    tally(
      sectionClasses,
      "sounding chord count differs from processed harmony",
      () => ({ id, ours: sounding.length, theirs: harmony.length }),
    );
    return;
  }

  let h = 0;
  section.chords.forEach((chord, i) => {
    if (!willSound(chord)) return;
    const their = harmony[h++];
    const reading = readings[i];
    const key = keyAt(id, section.keys, chord.beat);
    if (their === undefined || reading === undefined)
      throw new Error("unreachable: counts were checked");
    counts.paired++;
    const onset = chord.beat - 1;
    const timingOk =
      Math.abs(their.onset - onset) < BEAT_EPS &&
      Math.abs(their.offset - (onset + chord.duration)) < BEAT_EPS;
    const example = () => ({
      id,
      key,
      chord: chordFields(chord),
      ours: reading.kind === "sound" ? reading.sound : reading,
      theirs: theirs(their),
    });
    if (!timingOk) {
      tally(chordClasses, "onset/offset do not line up", example);
      return;
    }
    if (reading.kind !== "sound") {
      tally(
        chordClasses,
        `we read ${reading.kind}${reading.kind === "unreadable" ? ` (${reading.rule})` : ""}, reference sounds`,
        example,
      );
      return;
    }
    const diff: string[] = [];
    if (reading.sound.rootPc !== their.root_pitch_class) diff.push("rootPc");
    if (!sameNumbers(reading.sound.intervals, their.root_position_intervals))
      diff.push("intervals");
    if (reading.sound.inversion !== their.inversion) diff.push("inversion");
    if (diff.length > 0) {
      const shape = `applied=${chord.applied} borrowed=${borrowedKind(chord.borrowed)} type=${chord.type} alts=${chord.alterations.join(",") || "-"} sus=${chord.suspensions.join(",") || "-"}`;
      tally(chordClasses, `${diff.join("+")} differ | ${shape}`, example);
      return;
    }
    counts.agree++;
    if (emitFixtures) {
      const combo = JSON.stringify([
        key.scale,
        chord.applied,
        chord.borrowed === "" ? null : chord.borrowed,
        chord.type,
        chord.inversion,
        chord.adds,
        chord.omits,
        chord.alterations,
        chord.suspensions,
      ]);
      if (!fixtures.has(combo)) {
        fixtures.set(
          combo,
          encodeFixture({ chord, key, sound: reading.sound }),
        );
      }
    }
  });
}

// ─── stream the raw file ─────────────────────────────────────────────────────

const t0 = Date.now();
const parser = new JSONParser({ paths: ["$.*"], keepStack: false });
parser.onValue = ({ key, value }) => {
  if (typeof key !== "string")
    throw new Error(
      `raw file: top-level key ${String(key)} is not a section id`,
    );
  compareSection(key, RawEntrySchema.parse(value));
  if (counts.rawEntries % 5000 === 0) {
    console.log(
      `… ${counts.rawEntries} sections, ${Math.round((Date.now() - t0) / 1000)} s`,
    );
  }
};
for await (const chunk of createReadStream(rawPath).pipe(createGunzip())) {
  parser.write(chunk as Buffer);
}
for (const id of processedIds) {
  tally(sectionClasses, "processed section with no raw document", () => id);
}

// ─── report ──────────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(4)} %`;
console.log(`\n# Golden run (${Math.round((Date.now() - t0) / 1000)} s)`);
console.log(
  `raw entries ${counts.rawEntries}, without a document ${counts.noDocument}, sections compared ${counts.sections}`,
);
console.log(
  `raw non-rest chords ${counts.rawNonRestChords}, processed chords ${counts.processedChords}`,
);
console.log(
  `paired chords ${counts.paired}, agree ${counts.agree} (${pct(counts.agree, counts.paired)})`,
);
console.log(
  `keys: sections ${counts.keysCompared}, agree ${counts.keysAgree} (${pct(counts.keysAgree, counts.keysCompared)})`,
);
printTable("Chord disagreements", chordClasses);
printTable(
  "Sections whose processed harmony is empty (sections, then chords)",
  droppedSections,
);
printTable(
  "Sections kept by the reference although a chord ends after endBeat",
  overrunWithHarmony,
);
printTable("Other section-level findings", sectionClasses);
printTable(
  "Key disagreements, and repeated keys (kept by the processed file too)",
  keyClasses,
);

if (emitFixtures) {
  const file = join(
    import.meta.dir,
    "../core/testing/hookpad-sound.fixtures.ts",
  );
  const lines = [...fixtures.values()].sort();
  const content = `// GENERATED by scripts/hookpad-sound-golden.ts --emit-fixtures — do not edit.
//
// One chord per distinct combination of (key mode, applied, borrowed, type,
// inversion, adds, omits, alterations, suspensions) in the Sheet Sage dump,
// with the sound Sheet Sage's processed file gives it. Each line is
// \`<tonic> <mode> | <chord fields> | <rootPc> <intervals> <inversion>\`, read by
// \`decodeFixture\` in core/internal/hookpad-sound.fixture-format.ts.

export const HOOKPAD_SOUND_FIXTURES: readonly string[] = [
${lines.map((l) => `  ${JSON.stringify(l)},`).join("\n")}
];
`;
  writeFileSync(file, await formatSource({ file, content }));
  console.log(`\nWrote ${lines.length} fixtures to ${file}.`);
}
