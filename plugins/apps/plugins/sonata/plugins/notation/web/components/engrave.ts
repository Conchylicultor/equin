/**
 * VexFlow engraver: draws an {@link EngraveModel} into an SVG host as a system of
 * **N staves × M voices**, and returns the geometry the React component needs to
 * follow playback — a beat→x anchor list, per-system bounding boxes, and the
 * note SVG elements (tagged for highlight + click-to-seek).
 *
 * Layout generalizes the original grand staff: a part owns one staff (single
 * clef) or two (a treble/bass grand staff joined by a brace); when there is more
 * than one part the whole system is wrapped in a bracket. Each staff carries one
 * VexFlow `Voice` per `EngVoice`, with opposed stems for a 2-voice staff; all of
 * a measure's voices are joined into one `Formatter` so onsets align across the
 * system.
 *
 * Colors are supplied by the component (the fixed black-ink-on-white PAPER
 * palette) and applied to the VexFlow context. Sheet music is deliberately
 * monochrome and theme-independent — it never re-skins with light/dark or the
 * active preset, and per-track color is intentionally NOT used here.
 *
 * Line-break: measures are packed into a system greedily until the next would
 * overflow the container width, then a new system row starts. Widths come from
 * VexFlow's `Formatter.preCalculateMinTotalWidth`.
 */
import {
  Accidental,
  Annotation,
  Beam,
  Dot,
  Formatter,
  GraceNote,
  GraceNoteGroup,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Stem,
  Tuplet,
  Voice,
} from "vexflow";
import type {
  EngMeasure,
  EngPart,
  EngraveModel,
  EngStaff,
  EngTickable,
  EngVoice,
  StemDir,
} from "../internal/convert";
import {
  playheadPath,
  type MeasureSpan,
  type OnsetPoint,
} from "../internal/anchors";
import {
  measureStaffExtents,
  unionExtent,
  type StaffExtent,
} from "../internal/staff-extent";

/** An ascending beat→x mapping point within a system (drives the playhead). */
export interface BeatAnchor {
  beat: number;
  systemIndex: number;
  /** SYSTEM-LOCAL x within the per-system SVG (px from that svg's left edge). */
  x: number;
}

/** A drawn melodic note element, tagged for highlight + seek. */
export interface NoteEl {
  el: SVGElement;
  beat: number;
  /** Beat at which this note stops sounding (start + its length). */
  end: number;
}

/**
 * A single system's layout plan — pure geometry + measurement, no VexFlow
 * draw. {@link planEngraving} produces one per system row; {@link drawSystem}
 * turns one into its own `<svg>`. All coordinates are SYSTEM-LOCAL (rebased so
 * the system's box starts at y=0); the sizer places the row at `top`.
 */
export interface SystemPlan {
  index: number;
  /** Pure model slices — draw rebuilds fresh VexFlow voices from these. */
  measures: EngMeasure[];
  /** Parallel to `measures`: each measure's Pass-1 measured minimum width. */
  minWidths: number[];
  /** index === 0 → draw the time signature + part labels. */
  scoreStart: boolean;
  /** First-measure extra width (clef + key sig + optional time sig). */
  extra0: number;
  /** Proportional width scale applied to each measure's minimum. */
  scale: number;
  /** First measure's start beat — for the beat→system binary search. */
  startBeat: number;
  /** This system's top in sizer coordinates (the sum of earlier `pitch`es). */
  top: number;
  /**
   * Each staff's VexFlow `Stave` y within this system's box. Spaced per system
   * from the staves' ink extents, so ledger-line notes never collide or clip.
   */
  staffTops: number[];
  /** SVG box height: everything this system draws, plus a small pad. */
  boxHeight: number;
  /** Top-to-top distance to the next system (boxHeight + SYSTEM_GAP) — this
   *  system's virtual row size. */
  pitch: number;
  /** voiceKey "si:vi" receiving an incoming (from the previous system) tie. */
  tieIn: Set<string>;
  /** voiceKey "si:vi" sending a hanging tie into the next system. */
  tieOut: Set<string>;
}

/**
 * The whole-score layout plan: every system's geometry + the shared metrics the
 * virtualizer, the sizer, and the imperative playhead need. Pure — safe to
 * build inside a `useMemo` (no Renderer, no DOM, no colors).
 */
export interface EngravePlan {
  systems: SystemPlan[];
  /** Full engraving width (each per-system svg spans this). */
  width: number;
  /** Left gutter before the first measure (label gutter included). */
  leftPad: number;
  /** Whether per-part labels are drawn (multi-part + named). */
  hasLabels: boolean;
  /** Part layout (bracket/brace + labels). */
  parts: readonly EngPart[];
  /** Total sizer height (the sum of every system's `pitch`). */
  totalHeight: number;
}

/** What one drawn system registers for the imperative playhead + highlight. */
export interface SystemDrawResult {
  anchors: BeatAnchor[];
  notes: NoteEl[];
}

/** Ink colors for the engraving (the fixed black-on-white PAPER palette). */
export interface EngraveColors {
  /** Notes, clefs, staff lines, text (paper ink). */
  foreground: string;
  /** Highlight + playhead accent. */
  primary: string;
}

// --- Layout constants (px). ---
const LEFT_PAD = 12;
const RIGHT_PAD = 12;
/** Minimum top-to-top distance between the two staves of one grand-staff part. */
const STAFF_GAP = 80;
/** Minimum top-to-top distance between two distinct parts. */
const PART_PITCH = 112;
/** Clear space kept between one staff's lowest ink and the next staff's highest. */
const STAFF_CLEARANCE = 12;
/** Blank space between one system's box and the next system's box. */
const SYSTEM_GAP = 24;
/** Padding inside a system box, above its highest ink and below its lowest. */
const BOX_PAD = 6;
/** Stave-local y of a stave's top / bottom line (VexFlow's 4-space headroom). */
const TOP_LINE_Y = 40;
const BOTTOM_LINE_Y = 80;
/** Slack added to each measure's measured minimum width. */
const MEASURE_PAD = 24;
/** Clef + opening barline room on a system's first measure. */
const CLEF_WIDTH = 44;
/** Width per key-signature accidental. */
const KEYSIG_PER_ACC = 11;
/** Time-signature room on the score's very first measure. */
const TIMESIG_WIDTH = 26;
/** Left gutter reserved for per-part labels when they're drawn. */
const LABEL_GUTTER = 64;

/** Number of sharps/flats in a VexFlow key-signature name. */
const KEYSIG_ACCIDENTALS: Record<string, number> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  "F#": 6,
  "C#": 7,
  F: 1,
  Bb: 2,
  Eb: 3,
  Ab: 4,
  Db: 5,
  Gb: 6,
  Cb: 7,
  Am: 0,
  Em: 1,
  Bm: 2,
  "F#m": 3,
  "C#m": 4,
  "G#m": 5,
  "D#m": 6,
  "A#m": 7,
  Dm: 1,
  Gm: 2,
  Cm: 3,
  Fm: 4,
  Bbm: 5,
  Ebm: 6,
  Abm: 7,
};

function stemOf(stem: StemDir): number | undefined {
  if (stem === "up") return Stem.UP;
  if (stem === "down") return Stem.DOWN;
  return undefined;
}

/** Build a VexFlow StaveNote (chord or rest) from a tickable, with stem dir. */
function makeNote(
  t: EngTickable,
  clef: "treble" | "bass",
  stem: StemDir,
): StaveNote {
  const note = new StaveNote({
    keys: t.keys,
    duration: t.isRest ? `${t.duration}r` : t.duration,
    clef,
  });
  const dir = stemOf(stem);
  if (!t.isRest && dir !== undefined) note.setStemDirection(dir);
  for (let d = 0; d < t.dots; d++) Dot.buildAndAttach([note], { all: true });
  // Leading grace notes ride on their principal as a modifier group, added here
  // (before formatting) so their width is reserved in the layout.
  if (t.graceNotes?.length) attachGraces(note, t.graceNotes, clef);
  return note;
}

/**
 * Attach a tickable's leading grace notes to its principal `StaveNote` as a
 * `GraceNoteGroup` modifier. Graces live OUTSIDE the main `Voice`, so their
 * accidental glyphs are added by hand (the main-note path relies on
 * `Accidental.applyAccidentals`, which only walks voice tickables). A multi-note
 * group is beamed + slurred; a lone grace is a bare (usually slashed) acciaccatura.
 */
function attachGraces(
  principal: StaveNote,
  graces: NonNullable<EngTickable["graceNotes"]>,
  clef: "treble" | "bass",
): void {
  const gnotes = graces.map((g) => {
    const gnote = new GraceNote({
      keys: g.keys,
      duration: g.duration,
      slash: g.slash,
      clef,
    });
    // Grace key strings carry letter+octave only; render the accidental glyph
    // for each non-zero alteration, parallel to the grace's own keys.
    g.alters.forEach((alter, k) => {
      if (alter) {
        gnote.addModifier(
          new Accidental(alter > 0 ? "#".repeat(alter) : "b".repeat(-alter)),
          k,
        );
      }
    });
    return gnote;
  });
  const showSlur = gnotes.length > 1;
  const group = new GraceNoteGroup(gnotes, showSlur);
  if (showSlur) group.beamNotes();
  principal.addModifier(group, 0);
}

/**
 * Build the `Tuplet` objects for one voice's flat note list. Consecutive
 * tickables sharing the SAME `tuplet.id` form exactly one tuplet (`num` →
 * `num_notes`, `inSpace` → `notes_occupied`); grouping is by strict adjacent
 * equality, so two abutting windows with distinct ids never merge. The returned
 * tuplets wrap the exact `StaveNote` instances added to the voice, so they must
 * be drawn (not reconstructed) after the voice is formatted + drawn.
 */
function buildTuplets(
  tickables: readonly EngTickable[],
  notes: readonly StaveNote[],
): Tuplet[] {
  const tuplets: Tuplet[] = [];
  let i = 0;
  while (i < tickables.length) {
    const tup = tickables[i]!.tuplet;
    if (!tup) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < tickables.length && tickables[j]!.tuplet?.id === tup.id) j++;
    tuplets.push(
      new Tuplet(notes.slice(i, j), {
        num_notes: tup.num,
        notes_occupied: tup.inSpace,
        bracketed: true,
        ratioed: false,
      }),
    );
    i = j;
  }
  return tuplets;
}

/** A built voice: its engraving spec + the VexFlow note objects + Voice. */
interface BuiltVoice {
  eng: EngVoice;
  clef: "treble" | "bass";
  notes: StaveNote[];
  voice: Voice;
  /** Tuplets over `notes` (built once, drawn after the voice) — see buildTuplets. */
  tuplets: Tuplet[];
}

/** A built staff: its spec + built voices. */
interface BuiltStaff {
  staff: EngStaff;
  voices: BuiltVoice[];
}

/** Per-measure VexFlow build artifacts, reused across measure + draw passes. */
interface BuiltMeasure {
  measure: EngMeasure;
  staves: BuiltStaff[];
  minWidth: number;
}

/** Build the VexFlow voice + notes for one staff voice of a measure. */
function buildVoice(
  ev: EngVoice,
  clef: "treble" | "bass",
  measure: EngMeasure,
): BuiltVoice {
  const notes = ev.tickables.map((t) => makeNote(t, clef, ev.stem));
  const voice = new Voice({
    num_beats: measure.timeSig.numerator,
    beat_value: measure.timeSig.denominator,
  }).setMode(Voice.Mode.SOFT);
  voice.addTickables(notes);
  Accidental.applyAccidentals([voice], measure.keyName);
  // Tuplets wrap the same StaveNote instances now added to the voice; stored so
  // the draw pass can render each bracket after the voice + beams are drawn.
  const tuplets = buildTuplets(ev.tickables, notes);
  return { eng: ev, clef, notes, voice, tuplets };
}

/** All the VexFlow voices of a built measure, in staff/voice order. */
function allVoices(bm: BuiltMeasure): Voice[] {
  return bm.staves.flatMap((s) => s.voices.map((v) => v.voice));
}

/**
 * One system's vertical layout from its measures' ink: each staff's `Stave` y
 * within the box, and the box height. A staff sits far enough below the one
 * above that neither's ink (ledger-line notes, stems, chord symbols) reaches
 * the other, and never closer than the standard staff / part distance.
 */
function systemVerticalLayout(
  measures: readonly EngMeasure[],
  staves: readonly EngStaff[],
): { staffTops: number[]; boxHeight: number } {
  let extents: StaffExtent[] | null = null;
  for (const m of measures) {
    const ext = measureStaffExtents(m);
    extents = extents ? extents.map((e, i) => unionExtent(e, ext[i]!)) : ext;
  }
  const ext = extents ?? [];
  if (ext.length === 0) return { staffTops: [], boxHeight: 2 * BOX_PAD };
  const staffTops: number[] = [BOX_PAD - ext[0]!.top];
  for (let i = 1; i < ext.length; i++) {
    const minPitch =
      staves[i]!.partId === staves[i - 1]!.partId ? STAFF_GAP : PART_PITCH;
    const clear = ext[i - 1]!.bottom - ext[i]!.top + STAFF_CLEARANCE;
    staffTops.push(staffTops[i - 1]! + Math.max(minPitch, clear));
  }
  const last = ext.length - 1;
  return {
    staffTops,
    boxHeight: staffTops[last]! + ext[last]!.bottom + BOX_PAD,
  };
}

function connect(
  a: Stave,
  b: Stave,
  type: "brace" | "bracket" | "singleLeft" | "singleRight",
  ctx: ReturnType<Renderer["getContext"]>,
): void {
  new StaveConnector(a, b).setType(type).setContext(ctx).draw();
}

/**
 * PURE layout pass — no Renderer, no DOM, no colors, so it is safe to call
 * inside a `useMemo`. Runs Pass 1 (measure each measure's minimum width) and
 * Pass 2 (greedy line-break into systems), then computes per-system geometry
 * and the cross-system tie sets. VexFlow voices built here are used only to
 * MEASURE (single-use — formatting mutates them) and discarded; {@link
 * drawSystem} rebuilds fresh voices per system when it draws.
 */
export function planEngraving(model: EngraveModel, width: number): EngravePlan {
  // The staff shape is identical in every measure; take it from the first.
  const staffDefs = model.measures[0]?.staves ?? [];

  // Per-part labels: only meaningful for a multi-part (per-track) layout.
  const hasLabels = model.parts.length > 1 && model.parts.some((p) => p.name);
  const leftPad = LEFT_PAD + (hasLabels ? LABEL_GUTTER : 0);

  // --- Pass 1: measure each measure's minimum width (voices discarded). ---
  const minWidthByMeasure: number[] = model.measures.map((measure) => {
    const staves = measure.staves.map((staff) => ({
      staff,
      voices: staff.voices.map((ev) => buildVoice(ev, staff.clef, measure)),
    }));
    const bm: BuiltMeasure = { measure, staves, minWidth: 0 };
    const vfVoices = allVoices(bm);
    const min =
      vfVoices.length > 0
        ? new Formatter()
            .joinVoices(vfVoices)
            .preCalculateMinTotalWidth(vfVoices)
        : 60;
    return min + MEASURE_PAD;
  });

  // --- Pass 2: greedy line-break into systems (pure EngMeasure slices). ---
  const available = Math.max(120, width - leftPad - RIGHT_PAD);
  const firstExtra = (measure: EngMeasure, isScoreStart: boolean): number =>
    CLEF_WIDTH +
    (KEYSIG_ACCIDENTALS[measure.keyName] ?? 0) * KEYSIG_PER_ACC +
    (isScoreStart ? TIMESIG_WIDTH : 0);

  const sliceMeasures: EngMeasure[][] = [];
  const sliceMinWidths: number[][] = [];
  let curMeasures: EngMeasure[] = [];
  let curMinWidths: number[] = [];
  let running = 0;
  model.measures.forEach((measure, i) => {
    const minWidth = minWidthByMeasure[i]!;
    const startingSystem = curMeasures.length === 0;
    const extra = startingSystem ? firstExtra(measure, i === 0) : 0;
    const cost = minWidth + extra;
    if (!startingSystem && running + cost > available) {
      sliceMeasures.push(curMeasures);
      sliceMinWidths.push(curMinWidths);
      curMeasures = [measure];
      curMinWidths = [minWidth];
      running = firstExtra(measure, false) + minWidth;
    } else {
      running += cost;
      curMeasures.push(measure);
      curMinWidths.push(minWidth);
    }
  });
  if (curMeasures.length > 0) {
    sliceMeasures.push(curMeasures);
    sliceMinWidths.push(curMinWidths);
  }

  // Per-system geometry + width distribution. Systems stack top to bottom,
  // each as tall as its own ink needs.
  let top = 0;
  const systems: SystemPlan[] = sliceMeasures.map((measures, index) => {
    const minWidths = sliceMinWidths[index]!;
    const scoreStart = index === 0;
    const extra0 = firstExtra(measures[0]!, scoreStart);
    const totalMin = minWidths.reduce((s, w) => s + w, 0);
    const { staffTops, boxHeight } = systemVerticalLayout(measures, staffDefs);
    const pitch = boxHeight + SYSTEM_GAP;
    const systemTop = top;
    top += pitch;
    return {
      index,
      measures,
      minWidths,
      scoreStart,
      extra0,
      scale: (available - extra0) / totalMin,
      startBeat: measures[0]!.startBeat,
      top: systemTop,
      staffTops,
      boxHeight,
      pitch,
      tieIn: new Set<string>(),
      tieOut: new Set<string>(),
    };
  });

  // --- Cross-system ties (pure): mirror `drawTies`' predicate across each
  // boundary, keyed by the same "si:vi" voiceKey `tagVoice`/`drawSystem` use.
  // For each system, flatten every voiceKey's tickables in measure order and
  // record its first/last tickable.
  const firstTicks: Map<string, EngTickable>[] = [];
  const lastTicks: Map<string, EngTickable>[] = [];
  for (const sys of systems) {
    const seqs = new Map<string, EngTickable[]>();
    for (const measure of sys.measures) {
      measure.staves.forEach((staff, si) => {
        staff.voices.forEach((voice, vi) => {
          const vk = `${si}:${vi}`;
          let seq = seqs.get(vk);
          if (!seq) {
            seq = [];
            seqs.set(vk, seq);
          }
          for (const t of voice.tickables) seq.push(t);
        });
      });
    }
    const first = new Map<string, EngTickable>();
    const last = new Map<string, EngTickable>();
    for (const [vk, seq] of seqs) {
      if (seq.length === 0) continue;
      first.set(vk, seq[0]!);
      last.set(vk, seq.at(-1)!);
    }
    firstTicks.push(first);
    lastTicks.push(last);
  }
  for (let s = 0; s < systems.length - 1; s++) {
    const lastOf = lastTicks[s]!;
    const firstOf = firstTicks[s + 1]!;
    for (const [vk, a] of lastOf) {
      const b = firstOf.get(vk);
      if (a && b && a.tieToNext && !a.isRest && !b.isRest) {
        systems[s]!.tieOut.add(vk);
        systems[s + 1]!.tieIn.add(vk);
      }
    }
  }

  return {
    systems,
    width,
    leftPad,
    hasLabels,
    parts: model.parts,
    totalHeight: top,
  };
}

/**
 * Draw ONE system's plan into its own SVG `host`, y-rebased so the system box
 * starts at y=0 (the virtualizer places the row via a transform). Rebuilds
 * fresh VexFlow voices for this system (voices are single-use), draws staves /
 * connectors / chord symbols / voices / beams / tuplets, then in-system ties
 * and the cross-system hanging-tie stubs. Returns the beat→x anchors and tagged
 * note elements the imperative playhead + highlight consume.
 */
export function drawSystem(
  host: HTMLDivElement,
  plan: EngravePlan,
  systemIndex: number,
  colors: EngraveColors,
): SystemDrawResult {
  const sys = plan.systems[systemIndex]!;
  host.innerHTML = "";

  const renderer = new Renderer(host, Renderer.Backends.SVG);
  renderer.resize(plan.width, sys.boxHeight);
  const ctx = renderer.getContext();
  ctx.setFillStyle(colors.foreground);
  ctx.setStrokeStyle(colors.foreground);

  const staffTop = (i: number): number => sys.staffTops[i]!;

  const onsets: OnsetPoint[] = [];
  const spans: MeasureSpan[] = [];
  const notes: NoteEl[] = [];

  // Rebuild fresh voices per measure (Pass-1 voices were discarded).
  const built: BuiltMeasure[] = sys.measures.map((measure, mi) => ({
    measure,
    staves: measure.staves.map((staff) => ({
      staff,
      voices: staff.voices.map((ev) => buildVoice(ev, staff.clef, measure)),
    })),
    minWidth: sys.minWidths[mi]!,
  }));

  // Per (staffIndex:voiceIndex) flat note sequence, for tie drawing.
  const seqs = new Map<string, { t: EngTickable; n: StaveNote }[]>();

  let x = plan.leftPad;
  built.forEach((bm, mi) => {
    const isFirst = mi === 0;
    const w = sys.minWidths[mi]! * sys.scale + (isFirst ? sys.extra0 : 0);

    // Create one VexFlow Stave per staff at its vertical position.
    const vfStaves = bm.staves.map((_, si) => new Stave(x, staffTop(si), w));

    vfStaves.forEach((st, si) => {
      const def = bm.staves[si]!.staff;
      if (isFirst) {
        st.addClef(def.clef).addKeySignature(bm.measure.keyName);
        if (sys.scoreStart) {
          st.addTimeSignature(
            `${bm.measure.timeSig.numerator}/${bm.measure.timeSig.denominator}`,
          );
        }
      } else if (bm.measure.keyChanged) {
        st.addKeySignature(bm.measure.keyName);
      }
      st.setContext(ctx).draw();
    });

    drawConnectors(vfStaves, bm.measure.staves, plan.parts, isFirst, ctx);

    // Chord symbol above the first non-rest note of the top staff's top voice.
    if (bm.measure.chordSymbol && bm.staves.length > 0) {
      const topVoice = bm.staves[0]!.voices[0];
      if (topVoice && topVoice.notes.length > 0) {
        const idx = topVoice.eng.tickables.findIndex((t) => !t.isRest);
        const anchor = idx >= 0 ? topVoice.notes[idx]! : topVoice.notes[0]!;
        const ann = new Annotation(bm.measure.chordSymbol);
        ann.setVerticalJustification(Annotation.VerticalJustify.TOP);
        anchor.addModifier(ann, 0);
      }
    }

    // Join + format ALL voices of the measure so onsets align across staves.
    const vfVoices = allVoices(bm);
    const inner = vfStaves[0]
      ? vfStaves[0].getNoteEndX() - vfStaves[0].getNoteStartX()
      : Math.max(16, w - 24);
    if (vfVoices.length > 0) {
      new Formatter()
        .joinVoices(vfVoices)
        .format(vfVoices, Math.max(16, inner));
    }

    // Draw each voice on its staff, with per-voice beams + note tagging.
    bm.staves.forEach((bs, si) => {
      const st = vfStaves[si]!;
      bs.voices.forEach((bv, vi) => {
        const dir = stemOf(bv.eng.stem);
        const beams = Beam.generateBeams(
          bv.notes,
          dir !== undefined ? { stem_direction: dir } : undefined,
        );
        bv.voice.draw(ctx, st);
        beams.forEach((beam) => beam.setContext(ctx).draw());
        // Tuplet brackets/numbers, over the now-formatted notes.
        bv.tuplets.forEach((tuplet) => tuplet.setContext(ctx).draw());

        const key = `${si}:${vi}`;
        let seq = seqs.get(key);
        if (!seq) {
          seq = [];
          seqs.set(key, seq);
        }
        tagVoice(bv.eng.tickables, bv.notes, seq, onsets, notes);
      });
    });

    const { startBeat, timeSig } = bm.measure;
    spans.push({
      startBeat,
      endBeat:
        sys.measures[mi + 1]?.startBeat ??
        startBeat + (timeSig.numerator * 4) / timeSig.denominator,
      startX: vfStaves[0]?.getNoteStartX() ?? x,
      endX: x + w,
    });

    x += w;
  });

  // Draw in-system ties per voice sequence.
  for (const seq of seqs.values()) drawTies(seq, ctx);

  // Cross-system hanging ties: a stub in from the left edge for an incoming
  // tie, a stub off the right edge for an outgoing tie. VexFlow renders a
  // partial tie when one endpoint is null (the note's stave supplies the edge
  // x); `first_indices`/`last_indices` default to [0].
  for (const vk of sys.tieIn) {
    const seq = seqs.get(vk);
    if (seq?.length) {
      new StaveTie({ first_note: null, last_note: seq[0]!.n })
        .setContext(ctx)
        .draw();
    }
  }
  for (const vk of sys.tieOut) {
    const seq = seqs.get(vk);
    if (seq?.length) {
      new StaveTie({ first_note: seq.at(-1)!.n, last_note: null })
        .setContext(ctx)
        .draw();
    }
  }

  // Part labels (per-track only), on the score-start system, monochrome.
  if (plan.hasLabels && systemIndex === 0) {
    drawPartLabels(plan.parts, sys.staffTops, ctx);
  }

  const anchors = playheadPath(onsets, spans).map((p): BeatAnchor => ({
    ...p,
    systemIndex,
  }));

  return { anchors, notes };
}

/**
 * Draw the connectors joining a system's staves:
 *  - a `brace` + `singleLeft` across each grand-staff part (2 adjacent staves);
 *  - a `bracket` + `singleLeft` spanning the whole system when >1 part;
 *  - a `singleRight` barline across all staves closing every measure.
 * A lone single staff relies on the Stave's own barlines.
 */
function drawConnectors(
  vfStaves: Stave[],
  staffDefs: readonly EngStaff[],
  parts: readonly EngPart[],
  isFirst: boolean,
  ctx: ReturnType<Renderer["getContext"]>,
): void {
  const n = vfStaves.length;
  if (n < 2) return;
  const top = vfStaves[0]!;
  const bottom = vfStaves[n - 1]!;

  if (isFirst) {
    // Brace + left barline per grand-staff part (2 adjacent same-partId staves).
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && staffDefs[j + 1]!.partId === staffDefs[i]!.partId) {
        j++;
      }
      if (j > i) {
        connect(vfStaves[i]!, vfStaves[j]!, "brace", ctx);
        connect(vfStaves[i]!, vfStaves[j]!, "singleLeft", ctx);
      }
      i = j + 1;
    }
    if (parts.length > 1) {
      connect(top, bottom, "bracket", ctx);
    }
    // A single grand-staff part already has its own singleLeft above; a
    // multi-part system needs one spanning everything.
    if (parts.length > 1) connect(top, bottom, "singleLeft", ctx);
  }

  // Right barline closing every measure, across all staves.
  connect(top, bottom, "singleRight", ctx);
}

/** Tag drawn note elements + collect the onsets of one voice. */
function tagVoice(
  tickables: readonly EngTickable[],
  notes: readonly StaveNote[],
  seq: { t: EngTickable; n: StaveNote }[],
  onsets: OnsetPoint[],
  noteEls: NoteEl[],
): void {
  tickables.forEach((t, i) => {
    const note = notes[i]!;
    seq.push({ t, n: note });
    onsets.push({ beat: t.beat, x: note.getAbsoluteX() });
    if (t.isRest) return;
    const el = note.getSVGElement();
    if (!el) return;
    el.classList.add("vf-note");
    el.dataset.beat = String(t.beat);
    noteEls.push({ el, beat: t.beat, end: t.beat + t.beats });
  });
}

/** Draw in-system ties for one voice's flat note sequence. */
function drawTies(
  seq: { t: EngTickable; n: StaveNote }[],
  ctx: ReturnType<Renderer["getContext"]>,
): void {
  for (let i = 0; i < seq.length - 1; i++) {
    if (!seq[i]!.t.tieToNext || seq[i]!.t.isRest || seq[i + 1]!.t.isRest) {
      continue;
    }
    new StaveTie({ first_note: seq[i]!.n, last_note: seq[i + 1]!.n })
      .setContext(ctx)
      .draw();
  }
}

/** Draw a small left-margin label centered on each part's staves. */
function drawPartLabels(
  parts: readonly EngPart[],
  staffTops: readonly number[],
  ctx: ReturnType<Renderer["getContext"]>,
): void {
  ctx.save();
  ctx.setFont("Arial", 10, "normal");
  let staffIdx = 0;
  for (const part of parts) {
    const count = part.staffCount;
    if (part.name) {
      // Centered between the part's top line and its bottom line.
      const first = staffTops[staffIdx]!;
      const last = staffTops[staffIdx + count - 1] ?? first;
      const cy = (first + TOP_LINE_Y + last + BOTTOM_LINE_Y) / 2;
      ctx.fillText(part.name, 4, cy);
    }
    staffIdx += count;
  }
  ctx.restore();
}
