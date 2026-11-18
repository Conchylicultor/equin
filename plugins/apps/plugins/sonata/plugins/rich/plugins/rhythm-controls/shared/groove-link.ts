import {
  RHYTHMS,
  type RhythmPattern,
} from "@plugins/apps/plugins/sonata/plugins/rhythm/core";
import {
  DEFAULT_BASS_VOICING,
  DEFAULT_CHORD_VOICING,
  figurationsForHand,
  type HandVoicing,
} from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import type { GrooveFields } from "./groove";
import { HandVoicingSchema, RhythmPatternSchema } from "./resources";

/**
 * A groove as a song link spells it (`;groove=` on the player route) — words a
 * person can read and edit, in characters a URL leaves unescaped:
 *
 *   [preset~]R.<figuration>[.<token>…].<rhythm>~L.<figuration>[.<token>…].<rhythm>[~norestart]
 *
 *   stride~R.block.basic-2~L.stride.basic-4
 *   bossa-nova~R.harp-roll.o5.son.r2~L.root-fifth.x---x---x-x-----~norestart
 *
 * - `preset` — the groove preset it was applied from (provenance; omitted for
 *   none).
 * - `R` / `L` — the right hand (chords) and the left hand (bass), each its
 *   figuration (what it plays), then only what differs from that hand's
 *   default voicing — `o<octave>`, `vl` / `novl` (voice-leading), `dbl` /
 *   `nodbl` (octave doubling), `off` (the hand is silent), `r<n>` (the
 *   rhythm turned by n steps) — then its rhythm: a named rhythm (`son`,
 *   `basic-4`) when it strikes that rhythm's own steps, else one character per
 *   step, `x` struck and `-` silent.
 * - `norestart` — the rhythm keeps its place in the bar across chord changes
 *   (it restarts on each by default).
 */
const HAND_SEPARATOR = "~";
const FIELD_SEPARATOR = ".";
const NO_RESTART = "norestart";
const SIDES = { chord: "R", bass: "L" } as const;

type Hand = keyof typeof SIDES;

/** A preset id the grammar can carry as is. */
const PRESET_ID = /^[A-Za-z0-9_-]+$/;

const DEFAULT_VOICING: Record<Hand, HandVoicing> = {
  chord: DEFAULT_CHORD_VOICING,
  bass: DEFAULT_BASS_VOICING,
};

/** The groove as its link value. */
export function encodeGrooveLink(g: GrooveFields): string {
  const parts: string[] = [];
  if (g.presetId !== null && PRESET_ID.test(g.presetId)) parts.push(g.presetId);
  parts.push(encodeHand(g, "chord"), encodeHand(g, "bass"));
  if (!g.restartOnChordChange) parts.push(NO_RESTART);
  return parts.join(HAND_SEPARATOR);
}

function encodeHand(g: GrooveFields, hand: Hand): string {
  const voicing = hand === "bass" ? g.bassVoicing : g.chordVoicing;
  const pattern = hand === "bass" ? g.bass : g.chord;
  const base = DEFAULT_VOICING[hand];
  const fields: string[] = [
    SIDES[hand],
    hand === "bass" ? g.bassFigurationId : g.chordFigurationId,
  ];
  if (!voicing.enabled) fields.push("off");
  if (voicing.octave !== base.octave) fields.push(`o${voicing.octave}`);
  if (voicing.voiceLead !== base.voiceLead)
    fields.push(voicing.voiceLead ? "vl" : "novl");
  if (voicing.doubleOctave !== base.doubleOctave)
    fields.push(voicing.doubleOctave ? "dbl" : "nodbl");
  if (pattern.rotation !== 0) fields.push(`r${pattern.rotation}`);
  fields.push(encodeRhythm(pattern));
  return fields.join(FIELD_SEPARATOR);
}

/** A named rhythm when the pattern strikes its own steps, else its beads. */
function encodeRhythm(p: RhythmPattern): string {
  const named = RHYTHMS.find((r) => r.id === p.presetId);
  if (
    named !== undefined &&
    named.subdivisions === p.subdivisions &&
    named.onsets.length === p.onsets.length &&
    named.onsets.every((o, i) => o === p.onsets[i])
  ) {
    return named.id;
  }
  const struck = new Set(p.onsets);
  let beads = "";
  for (let i = 0; i < p.subdivisions; i++) beads += struck.has(i) ? "x" : "-";
  return beads;
}

/** A link value that is a groove, or why it is not one. */
export type GrooveLinkResult =
  { ok: true; groove: GrooveFields } | { ok: false; reason: string };

type HandResult =
  | {
      ok: true;
      figurationId: string;
      voicing: HandVoicing;
      pattern: RhythmPattern;
    }
  | { ok: false; reason: string };

/**
 * The groove a link value spells, or why it does not spell one. A link is
 * typed, pasted or stale, so a bad value is an answer, not a crash: every
 * pattern and voicing is checked by the same schemas the write endpoint
 * validates with, and each figuration must be one its hand offers.
 */
export function decodeGrooveLink(value: string): GrooveLinkResult {
  const parts = value.split(HAND_SEPARATOR);
  let restartOnChordChange = true;
  if (parts[parts.length - 1] === NO_RESTART) {
    restartOnChordChange = false;
    parts.pop();
  }
  let presetId: string | null = null;
  if (parts.length === 3) {
    const preset = parts.shift() as string;
    if (!PRESET_ID.test(preset)) {
      return { ok: false, reason: `not a preset id: ${preset}` };
    }
    presetId = preset;
  }
  if (parts.length !== 2) {
    return { ok: false, reason: "a groove is a right and a left hand" };
  }
  const chord = decodeHand(parts[0] as string, "chord");
  if (!chord.ok) return chord;
  const bass = decodeHand(parts[1] as string, "bass");
  if (!bass.ok) return bass;
  return {
    ok: true,
    groove: {
      presetId,
      restartOnChordChange,
      chord: chord.pattern,
      chordFigurationId: chord.figurationId,
      chordVoicing: chord.voicing,
      bass: bass.pattern,
      bassFigurationId: bass.figurationId,
      bassVoicing: bass.voicing,
    },
  };
}

function decodeHand(text: string, hand: Hand): HandResult {
  const fields = text.split(FIELD_SEPARATOR);
  const side = fields.shift();
  if (side !== SIDES[hand]) {
    return { ok: false, reason: `expected the ${SIDES[hand]} hand: ${text}` };
  }
  const figurationId = fields.shift();
  const rhythm = fields.pop();
  if (figurationId === undefined || rhythm === undefined) {
    return {
      ok: false,
      reason: `a hand is a figuration and a rhythm: ${text}`,
    };
  }
  if (!figurationsForHand(hand).some((f) => f.id === figurationId)) {
    return { ok: false, reason: `unknown ${hand} figuration: ${figurationId}` };
  }
  const voicing: HandVoicing = { ...DEFAULT_VOICING[hand] };
  let rotation = 0;
  for (const token of fields) {
    const octave = /^o(\d+)$/.exec(token);
    const turn = /^r(\d+)$/.exec(token);
    if (octave) voicing.octave = Number(octave[1]);
    else if (turn) rotation = Number(turn[1]);
    else if (token === "off") voicing.enabled = false;
    else if (token === "vl") voicing.voiceLead = true;
    else if (token === "novl") voicing.voiceLead = false;
    else if (token === "dbl") voicing.doubleOctave = true;
    else if (token === "nodbl") voicing.doubleOctave = false;
    else return { ok: false, reason: `unknown ${hand} hand token: ${token}` };
  }
  const parsedVoicing = HandVoicingSchema.safeParse(voicing);
  if (!parsedVoicing.success) {
    return { ok: false, reason: parsedVoicing.error.message };
  }
  const named = RHYTHMS.find((r) => r.id === rhythm);
  let candidate: RhythmPattern;
  if (named !== undefined) {
    candidate = {
      presetId: named.id,
      subdivisions: named.subdivisions,
      onsets: [...named.onsets],
      rotation,
    };
  } else if (/^[x-]+$/.test(rhythm)) {
    const onsets: number[] = [];
    for (let i = 0; i < rhythm.length; i++)
      if (rhythm[i] === "x") onsets.push(i);
    candidate = {
      presetId: null,
      subdivisions: rhythm.length,
      onsets,
      rotation,
    };
  } else {
    return { ok: false, reason: `not a rhythm: ${rhythm}` };
  }
  const pattern = RhythmPatternSchema.safeParse(candidate);
  if (!pattern.success) return { ok: false, reason: pattern.error.message };
  return {
    ok: true,
    figurationId,
    voicing: parsedVoicing.data,
    pattern: pattern.data,
  };
}
