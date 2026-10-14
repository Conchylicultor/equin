import {
  accidentalGlyph,
  buildTempoIndex,
  isAccidental,
  type KeySpeller,
  type Note,
  type AxisTimeline,
  type PitchColumn,
  type PitchPlane,
  type Projection,
  type Score,
  type TempoIndex,
} from "@plugins/apps/plugins/sonata/plugins/score/core";

/**
 * The piano roll's coordinate model — pure, framework-free, so the renderer and
 * the published `Projection` share ONE source of truth. The roll is VERTICAL,
 * Synthesia-style:
 *
 *  - X (pitch): the range A0–C8 laid across the container width by the ACTIVE
 *               keyboard layout (see the `pitch-layout` plugin) — a piano's
 *               tiled naturals and boundary-riding accidentals, or Jankó's
 *               uniform pads. The roll holds no key formula of its own: it is
 *               handed one `PitchPlane` and reads its `columns`, the same pads
 *               the keyboard below renders, so every note lands exactly on its
 *               key. A pitch the plane does not carry has no column, and is
 *               DROPPED rather than drawn at a fabricated position.
 *  - Y (time):  the time axis is anchored in AUTHORED (base-tempo) seconds and
 *               lives in CONTENT-SPACE (cursor-invariant):
 *               y = -seconds(beat) * pxPerSecond, where
 *               pxPerSecond = PX_PER_SECOND * tempoScale. The incoming `score`
 *               already has `tempoScale` folded into its tempo map
 *               (seconds = authoredSeconds / tempoScale), so multiplying by
 *               tempoScale here cancels it: a note's pixel HEIGHT is its authored
 *               duration and never changes with tempo. What tempo changes is the
 *               SCROLL SPEED — the cursor sweeps wall-clock seconds at 1×, so the
 *               roll scrolls at PX_PER_SECOND * tempoScale px/sec: slow the tempo
 *               and the whole roll scrolls slower instead of notes stretching.
 *               The per-frame scroll is NOT baked into the geometry — the display
 *               applies it as a single `translateY(offset)` on one layer, where
 *               `offset = height + seconds(cursorBeat) * pxPerSecond` maps the
 *               cursor to the lane bottom (the keyboard). Because the cursor never
 *               enters the geometry, the projection (and every note rect) is stable
 *               while playing; only the layer's transform moves. Layout is a pure
 *               function of the score + lane width + tempoScale — no per-frame
 *               React state.
 *
 * A note rectangle spans from its end (top, further in the future) to its onset
 * (bottom), and is as wide as its key. `noteToRect` is the canonical note
 * geometry both the renderer and overlays consume.
 */

/**
 * Vertical pixels per authored-tempo second at zoom 1× (`tempoScale` 1). This is
 * the 1× BASELINE the spread wheel reads against — chosen as the Synthesia-style
 * spread-out default (it was the old fixed 180 with the former 1.5 default folded
 * in). The effective scale is `PX_PER_SECOND * tempoScale * spread`, so the wheel
 * (spread) and tempo both scale the scroll rate from here; only spread also
 * scales note heights.
 */
export const PX_PER_SECOND = 270;

/**
 * Round a CSS-pixel offset to the nearest PHYSICAL pixel (`1 / dpr` CSS px).
 * The canvas scroll root and the DOM overlay layer both scroll through this, so
 * content lands on whole device pixels (crisp mid-scroll) and the two layers
 * round identically (stay glued).
 */
export function snapToDevicePixel(cssPx: number, dpr: number): number {
  return Math.round(cssPx * dpr) / dpr;
}

/**
 * Vertical zoom of the falling notes ("spread"), Synthesia-style — a pure
 * multiplier on {@link PX_PER_SECOND}, read by the toolbar wheel as a zoom level
 * (`1×` = the baseline above). Higher values make notes taller and the look-ahead
 * shorter (and the roll scrolls proportionally faster, since the music plays at
 * the same speed). Unlike `tempoScale` — which scales the scroll RATE but cancels
 * out of note heights — `spread` scales EVERYTHING, including heights, which is
 * exactly the "taller notes" zoom. The live value is ephemeral transport state
 * (the Sonata context). `SPREAD_MIN` is the DEFAULT zoom-out floor and the
 * persisted `pianoRollConfig.spread` field's lower clamp; the LIVE floor is
 * dynamic and can drop below it so a long song can be zoomed out until it fully
 * fits the lane (the renderer computes that floor and feeds the Sonata context —
 * see `setSpreadFloor`). Kept here so the geometry owns the one definition of the
 * default spread range. */
export const SPREAD_MIN = 0.4;
export const SPREAD_MAX = 3;
export const SPREAD_DEFAULT = 1;

/** Full 88-key piano range: A0 (21) … C8 (108). */
export const KEYBOARD_LOW = 21;
export const KEYBOARD_HIGH = 108;

/**
 * AUTHORED (base-tempo) seconds of a beat. The incoming score's tempo map has
 * the playback `tempoScale` folded in (see the file header: its seconds are
 * authoredSeconds / tempoScale), so multiplying `beatToSeconds` by `tempoScale`
 * cancels the fold and recovers the tempo-INVARIANT authored timeline. This is
 * the Y axis the note geometry is authored in: a note's authored span never
 * changes when the user slows/speeds playback — only the scroll rate does
 * (pxPerSecond = PX_PER_SECOND * tempoScale). Pure.
 */
export function authoredSecondsOf(
  tempo: TempoIndex,
  tempoScale: number,
  beat: number,
): number {
  return tempo.beatToSeconds(beat) * tempoScale;
}

/**
 * One note's render-ready visual, in resolution-independent AUTHORED space:
 * X in column-fractions of the lane width (0..1, from the active layout's
 * `PitchPlane`), Y in authored seconds (see `authoredSecondsOf`).
 * This is the contract between the pure geometry and the canvas renderer —
 * built ONCE per (score, hidden-set, colors, tempoScale); resize and scroll
 * never touch it (the renderer maps it to pixels with a single transform).
 */
export interface NoteVisual {
  noteId: string;
  trackId: string;
  /** Left edge as a fraction of the lane width (0..1). */
  xFrac: number;
  /** Width as a fraction of the lane width (0..1). */
  wFrac: number;
  /** Onset, in authored seconds (tempo-invariant). */
  y0Sec: number;
  /** End (onset + duration), in authored seconds. Always >= y0Sec. */
  y1Sec: number;
  /**
   * The note's CSS color EXPRESSION, unresolved — track colors arrive as CSS
   * strings (typically `var(--categorical-N)`), and notes without a resolved
   * track color carry `var(--primary)`. Always a string (never null) so the
   * downstream CSS→number resolution is one uniform path with no fallback
   * branch at the consumer.
   */
  colorExpr: string;
  /**
   * The note BODY's CSS color expression — the Synthesia white-key shade for
   * naturals, its darker black-key partner for accidentals. Kept apart from
   * `colorExpr` (the undarkened base) so the renderer fills with the right
   * shade while FX still read the base.
   */
  fillExpr: string;
  /** Fill opacity. 1 = fully opaque (Synthesia draws solid notes). */
  alpha: number;
  /** Notes on accidental pitch classes; drives the darker shade + FX. */
  isAccidental: boolean;
  /**
   * Note-name label parts, kept apart so the accidental glyph can be rendered
   * compact + tucked against the letter. ALWAYS populated — whether labels are
   * shown (the `showNoteNames` toggle, fit thresholds) is the renderer's
   * concern, so toggling labels never rebuilds the visuals.
   */
  label: { step: string; accidental: string } | null;
}

/**
 * Build every visible note's {@link NoteVisual} — the pure, framework-free
 * replacement for the piano-roll's per-note rect memo. Hidden tracks are
 * dropped entirely; spelling prefers the note's own populated `spelling` (from
 * the key-context pass) and falls back to lazy key-aware spelling. Positions
 * are authored-space (key-fraction × authored-seconds), so the result is
 * invariant under lane resizes AND tempo changes — only score/track-view
 * changes rebuild it.
 */
export function buildNoteVisuals(input: {
  /** Score with `tempoScale` already folded into its tempo map (see header). */
  score: Score;
  /**
   * The pitch axis these notes fall on — the SAME plane the keyboard below
   * renders, so a note's column is its key's column by construction. A note
   * whose pitch has no column here is dropped.
   */
  plane: PitchPlane;
  /** Track ids dropped from the roll (track-mixer "hide"). */
  hiddenIds: ReadonlySet<string>;
  /** trackId → CSS color expression (the track-mixer's per-song track views). */
  colorMap: ReadonlyMap<string, string>;
  /**
   * Base color → its Synthesia accidental (sharp/flat) shade. Injected (not
   * imported) so this module stays free of the track-mixer barrel and its
   * React graph — keeping `buildNoteVisuals` pure + unit-testable.
   */
  accidentalColor: (base: string) => string;
  /** Key-signature-aware speller for notes left unspelled by the source. */
  speller: KeySpeller;
  /** Playback tempo multiplier (1 = authored) — cancels the score's fold. */
  tempoScale: number;
}): NoteVisual[] {
  const {
    score,
    plane,
    hiddenIds,
    colorMap,
    accidentalColor,
    speller,
    tempoScale,
  } = input;
  const tempo = buildTempoIndex(score);
  const byPitch = columnsByPitch(plane);

  const visuals: NoteVisual[] = [];
  for (const n of score.notes) {
    if (hiddenIds.has(n.track)) continue;
    const col = byPitch.get(n.pitch);
    // Not on this axis: no visual at all. There is no honest place to draw a
    // pitch the layout does not carry, and the old fallback (a white-key-wide
    // bar pinned at x=0) drew one anyway, indistinguishable from a real note.
    if (!col) continue;
    const s = n.spelling ?? speller.spell(n.pitch);
    const base = colorMap.get(n.track) ?? "var(--primary)";
    const accidental = isAccidental(n.pitch);
    visuals.push({
      noteId: n.id,
      trackId: n.track,
      xFrac: col.center - col.width / 2,
      wFrac: col.width,
      y0Sec: authoredSecondsOf(tempo, tempoScale, n.start),
      y1Sec: authoredSecondsOf(tempo, tempoScale, n.start + n.duration),
      colorExpr: base,
      fillExpr: accidental ? accidentalColor(base) : base,
      alpha: 1,
      isAccidental: accidental,
      label: { step: s.step, accidental: accidentalGlyph(s.alter) },
    });
  }
  return visuals;
}

/** Pitch → its note column on `plane`. One place, so the visuals and the
 *  projection can never disagree about which pitches the axis carries. */
function columnsByPitch(plane: PitchPlane): Map<number, PitchColumn> {
  return new Map(plane.columns.map((c) => [c.pitch, c]));
}

/**
 * Build the `Projection` the piano roll publishes. The closures here ARE the
 * geometry the renderer draws with — overlays and the keyboard consuming this
 * projection land pixel-exact on the notes. The Y axis is CONTENT-SPACE and
 * cursor-invariant; the display applies the per-frame scroll as a single
 * `translateY` (see the file header), so this projection is stable while
 * playing and recomputes only on lane-size / score change.
 */
export function buildProjection(input: {
  width: number;
  height: number;
  /**
   * The pitch axis, in fractions. Scaled to `width` here — the ONE place
   * fractions become pixels, so the published projection and the falling notes
   * are the same geometry at two resolutions.
   */
  plane: PitchPlane;
  /**
   * The AXIS score the roll draws — the song as written, or the song with its
   * A–B loop unrolled ahead (`unrollLoop`). Its tempo map converts axis beats
   * → wall-clock seconds for the Y axis.
   */
  score: Score;
  /** How that axis lays out the transport — published as `timeline`. */
  timeline: AxisTimeline;
  /** Playback tempo multiplier (1 = authored). Scales the scroll rate so slowing
   *  the tempo slows the scroll instead of stretching note heights. */
  tempoScale: number;
  /** Vertical zoom (1 = base). Scales the whole Y axis — note positions AND
   *  heights — so DOM overlays stay glued to the zoomed canvas notes. */
  spread: number;
}): Projection {
  const { width, height, plane, score, timeline, tempoScale, spread } = input;
  const byPitch = columnsByPitch(plane);

  // Content-space Y: a note's beat maps to a fixed pixel position independent of
  // the cursor (the cursor offset is applied downstream as one translateY).
  // `score` already has `tempoScale` folded into its tempo map, so its seconds
  // are authoredSeconds / tempoScale; multiplying px/sec by tempoScale cancels
  // that, so note heights become authored-duration (tempo-independent) and the
  // cursor's constant wall-clock sweep yields a scroll rate of
  // PX_PER_SECOND * tempoScale — slower tempo, slower scroll.
  const tempo = buildTempoIndex(score);
  // `spread` zooms the whole axis on top of the tempo-cancelled px/sec.
  const pxPerSecond = PX_PER_SECOND * tempoScale * spread;
  const beatToY = (beat: number): number =>
    -tempo.beatToSeconds(beat) * pxPerSecond;
  const yToBeat = (y: number): number => tempo.secondsToBeat(-y / pxPerSecond);
  // `null` for a pitch the axis does not carry — a stated "not here", not a
  // fabricated position an overlay would anchor to (see `Projection`).
  const pitchToX = (pitch: number): number | null => {
    const col = byPitch.get(pitch);
    return col ? col.center * width : null;
  };
  const noteToRect = (note: Note) => {
    const col = byPitch.get(note.pitch);
    if (!col) return null;
    const w = col.width * width;
    const center = col.center * width;
    const endY = beatToY(note.start + note.duration);
    return {
      x: center - w / 2,
      // Top = note end (further in the future, higher up); height spans the
      // note's authored duration, so it stays fixed across tempo changes.
      y: endY,
      w,
      h: beatToY(note.start) - endY,
    };
  };

  return {
    capabilities: new Set(["time-axis", "pitch-plane"]),
    viewport: { width, height },
    beatToY,
    yToBeat,
    pitchToX,
    noteToRect,
    pitchPlane: plane,
    timeline,
  };
}
