import {
  SONATA_DEFAULT_LOOK,
  SONATA_LOOK_STYLES,
} from "@plugins/apps/plugins/sonata/plugins/look/core";
import { pitchGeometry } from "@plugins/apps/plugins/sonata/plugins/pitch-layout/core";
import {
  bars,
  type Note,
  type Score,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import { COVER_H, COVER_W, n, svgDocument } from "./svg";
import { busiestWindow } from "./window";

/**
 * The look a cover is drawn in: the app's DEFAULT look, not the user's current
 * one. A cover is a cached file shared by every surface, so it cannot follow a
 * per-user switch; the default is what a fresh install's player looks like.
 */
const LOOK = SONATA_LOOK_STYLES[SONATA_DEFAULT_LOOK];

/** Keyboard strip height: ~12% of the cover, under the falling notes. */
const KEYBED_H = 24;
const LANE_H = COVER_H - KEYBED_H;

/**
 * The immersive keybed, flattened: the ivory, ebony and seam the keyboard
 * primitive's `immersive` skin paints (`keyboard/web/internal/chrome/piano.tsx`),
 * each gradient taken at its body colour since a cover's strip is flat.
 */
const KEY_IVORY = "#e4dfd6";
const KEY_EBONY = "#26262e";
const KEY_SEAM = "#08080c";

/** Glow strength of a note sounding at the bottom edge, and its blur radius. */
const GLOW_ALPHA = 0.9;
const GLOW_BLUR = 2.2;

/**
 * A falling-notes cover of the song's busiest four bars, in the default look.
 *
 * 320×200 SVG: the look's lane ground with its C/F column rules and bar rules,
 * every note sounding in the window as a rounded bar (time runs UP: the
 * window's first beat sits on the keyboard, its last at the top), x from the
 * piano geometry the player's own keyboard is laid out from, coloured by its
 * track's index in `score.tracks` through the look's track palette. A note
 * sounding at the bottom edge — the moment the cover freezes — glows over the
 * keyboard and lights its key, as in the player. A flat keyboard strip spans
 * the same range underneath.
 *
 * Deterministic: the same Score always produces the same bytes. An empty score
 * draws an honest empty roll (lane, rules, keyboard; no notes).
 */
export function renderRollCover(score: Score): string {
  const win = busiestWindow(score);
  const plane = pitchGeometry("piano", win.lowPitch, win.highPitch);
  const span = win.endBeat - win.startBeat;
  const beatY = (beat: number) => LANE_H * (1 - (beat - win.startBeat) / span);

  const trackIndex = new Map(score.tracks.map((t, i) => [t.id, i]));
  const colorOf = (note: Note) => {
    const i = trackIndex.get(note.track) ?? 0;
    return LOOK.tracks[i % LOOK.tracks.length]!;
  };
  const columnOf = new Map(plane.columns.map((c) => [c.pitch, c]));

  const parts: string[] = [];
  parts.push(
    `<defs><filter id="glow" x="-50%" y="-200%" width="200%" height="500%">` +
      `<feGaussianBlur stdDeviation="${GLOW_BLUR}"/></filter></defs>`,
  );
  parts.push(
    `<rect width="${COVER_W}" height="${COVER_H}" fill="${LOOK.laneBg}"/>`,
  );

  // Column rules at every C (strong) and F (weak) — the plane's guides.
  const ink = LOOK.grid.colorExpr;
  for (const g of plane.guides) {
    if (g.frac <= 0) continue;
    const alpha = g.strong
      ? LOOK.grid.octaveLineAlpha
      : LOOK.grid.pitchLineAlpha;
    parts.push(
      `<rect x="${n(g.frac * COVER_W)}" y="0" width="0.6" height="${LANE_H}" fill="${ink}" fill-opacity="${alpha}"/>`,
    );
  }
  // Bar rules inside the window.
  for (const b of bars(score)) {
    if (b.startBeat <= win.startBeat || b.startBeat >= win.endBeat) continue;
    parts.push(
      `<rect x="0" y="${n(beatY(b.startBeat))}" width="${COVER_W}" height="0.6" fill="${ink}" fill-opacity="${LOOK.grid.barLineAlpha}"/>`,
    );
  }

  // Notes, in a stable order (start, pitch, id) so equal input → equal bytes.
  const shown = score.notes
    .filter(
      (note) =>
        note.start < win.endBeat &&
        note.start + note.duration > win.startBeat &&
        columnOf.has(note.pitch),
    )
    .sort(
      (a, b) =>
        a.start - b.start ||
        a.pitch - b.pitch ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const glows: string[] = [];
  const lit = new Map<number, string>();
  for (const note of shown) {
    const col = columnOf.get(note.pitch)!;
    const colW = col.width * COVER_W;
    const inset = Math.min(LOOK.notes.insetPx, colW / 10);
    const x = (col.center - col.width / 2) * COVER_W + inset;
    const w = colW - inset * 2;
    const top = Math.max(0, beatY(note.start + note.duration));
    const bottom = Math.min(LANE_H, beatY(note.start));
    const h = bottom - top;
    if (h <= 0 || w <= 0) continue;
    const r = Math.min(LOOK.notes.radiusPx, w / 2, h / 2);
    const color = colorOf(note);
    const sounding = note.start <= win.startBeat;
    const opacity = sounding ? 1 : 0.62 + 0.38 * (note.velocity / 127);
    parts.push(
      `<rect class="note" data-track="${trackIndex.get(note.track) ?? 0}" x="${n(x)}" y="${n(top)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${color}" fill-opacity="${opacity.toFixed(2)}"/>`,
    );
    if (sounding) {
      glows.push(
        `<rect x="${n(x - 1.5)}" y="${n(LANE_H - 3)}" width="${n(w + 3)}" height="5" rx="2.5" fill="${color}"/>`,
      );
      lit.set(note.pitch, color);
    }
  }

  // The keyboard strip: naturals, then accidentals over them (plane order).
  parts.push(
    `<rect x="0" y="${LANE_H}" width="${COVER_W}" height="${KEYBED_H}" fill="${KEY_SEAM}"/>`,
  );
  for (const key of plane.keys) {
    const x = (key.center - key.width / 2) * COVER_W;
    const w = key.width * COVER_W;
    const h = key.height * (KEYBED_H - 1);
    const natural = key.tier === 0;
    const fill = lit.get(key.pitch) ?? (natural ? KEY_IVORY : KEY_EBONY);
    parts.push(
      natural
        ? `<rect x="${n(x)}" y="${LANE_H + 1}" width="${n(w - 0.8)}" height="${n(h)}" fill="${fill}"/>`
        : `<rect x="${n(x)}" y="${LANE_H + 1}" width="${n(w)}" height="${n(h)}" rx="1" fill="${fill}"/>`,
    );
  }

  if (glows.length > 0) {
    parts.push(
      `<g filter="url(#glow)" opacity="${GLOW_ALPHA}">${glows.join("")}</g>`,
    );
  }

  return svgDocument(parts.join(""));
}
