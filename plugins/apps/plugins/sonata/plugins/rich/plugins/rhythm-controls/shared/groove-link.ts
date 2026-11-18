import { z } from "zod";
import { wholeList } from "@plugins/packages/plugins/list-bound/core";
import { figurationsForHand } from "@plugins/apps/plugins/sonata/plugins/voicing/core";
import type { GrooveFields } from "./groove";
import { HandVoicingSchema, RhythmPatternSchema } from "./resources";

/**
 * A groove as a song link spells it (`;groove=` on the player route): the
 * format's version, a dot, then the groove as a compact JSON tuple in
 * base64url — every field of {@link GrooveFields}, positional so the link
 * stays short.
 *
 *   [presetId, restartOnChordChange, chordHand, bassHand]
 *   hand = [figurationId, [enabled, octave, voiceLead, doubleOctave],
 *           [subdivisions, onsets, rotation, patternPresetId]]
 *
 * Booleans are 0/1. A new layout is a new version; a reader refuses any
 * version it does not know.
 */
const VERSION = "1";

const Bit = z.union([z.literal(0), z.literal(1)]);

const HandTuple = z.tuple([
  z.string(),
  z.tuple([Bit, z.number(), Bit, Bit]),
  z.tuple([
    z.number(),
    wholeList(z.number(), {
      reason: "one pattern's onsets, each below its subdivisions (≤ 48)",
    }),
    z.number(),
    z.string().nullable(),
  ]),
]);

const GrooveTuple = z.tuple([z.string().nullable(), Bit, HandTuple, HandTuple]);

type Hand = "bass" | "chord";

function handTuple(g: GrooveFields, hand: Hand): z.infer<typeof HandTuple> {
  const voicing = hand === "bass" ? g.bassVoicing : g.chordVoicing;
  const pattern = hand === "bass" ? g.bass : g.chord;
  return [
    hand === "bass" ? g.bassFigurationId : g.chordFigurationId,
    [
      voicing.enabled ? 1 : 0,
      voicing.octave,
      voicing.voiceLead ? 1 : 0,
      voicing.doubleOctave ? 1 : 0,
    ],
    [
      pattern.subdivisions,
      [...pattern.onsets],
      pattern.rotation,
      pattern.presetId,
    ],
  ];
}

/** The groove as its link value. */
export function encodeGrooveLink(g: GrooveFields): string {
  const tuple: z.infer<typeof GrooveTuple> = [
    g.presetId,
    g.restartOnChordChange ? 1 : 0,
    handTuple(g, "chord"),
    handTuple(g, "bass"),
  ];
  return `${VERSION}.${toBase64Url(JSON.stringify(tuple))}`;
}

/** Why a link value is not a groove. */
export type GrooveLinkResult =
  { ok: true; groove: GrooveFields } | { ok: false; reason: string };

/**
 * The groove a link value spells, or why it does not spell one. A link is
 * typed, pasted or stale, so a bad value is an answer, not a crash: every
 * pattern and voicing is checked by the same schemas the write endpoint
 * validates with, and each figuration must be one its hand offers.
 */
export function decodeGrooveLink(value: string): GrooveLinkResult {
  const dot = value.indexOf(".");
  if (dot < 0 || value.slice(0, dot) !== VERSION) {
    return { ok: false, reason: "unknown groove link version" };
  }
  const json = fromBase64Url(value.slice(dot + 1));
  if (json === null) return { ok: false, reason: "not base64url" };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, reason: "not JSON" };
  }
  const tuple = GrooveTuple.safeParse(data);
  if (!tuple.success) return { ok: false, reason: tuple.error.message };
  const [presetId, restart, chordTuple, bassTuple] = tuple.data;
  const chord = readHand(chordTuple, "chord");
  if (!chord.ok) return chord;
  const bass = readHand(bassTuple, "bass");
  if (!bass.ok) return bass;
  return {
    ok: true,
    groove: {
      presetId,
      restartOnChordChange: restart === 1,
      chord: chord.pattern,
      chordFigurationId: chord.figurationId,
      chordVoicing: chord.voicing,
      bass: bass.pattern,
      bassFigurationId: bass.figurationId,
      bassVoicing: bass.voicing,
    },
  };
}

function readHand(
  [figurationId, v, p]: z.infer<typeof HandTuple>,
  hand: Hand,
):
  | {
      ok: true;
      figurationId: string;
      voicing: GrooveFields["bassVoicing"];
      pattern: GrooveFields["bass"];
    }
  | { ok: false; reason: string } {
  if (!figurationsForHand(hand).some((f) => f.id === figurationId)) {
    return { ok: false, reason: `unknown ${hand} figuration: ${figurationId}` };
  }
  const voicing = HandVoicingSchema.safeParse({
    enabled: v[0] === 1,
    octave: v[1],
    voiceLead: v[2] === 1,
    doubleOctave: v[3] === 1,
  });
  if (!voicing.success) return { ok: false, reason: voicing.error.message };
  const pattern = RhythmPatternSchema.safeParse({
    subdivisions: p[0],
    onsets: p[1],
    rotation: p[2],
    presetId: p[3],
  });
  if (!pattern.success) return { ok: false, reason: pattern.error.message };
  return {
    ok: true,
    figurationId,
    voicing: voicing.data,
    pattern: pattern.data,
  };
}

function toBase64Url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The text a base64url string holds, or null when it is not base64url. */
function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
