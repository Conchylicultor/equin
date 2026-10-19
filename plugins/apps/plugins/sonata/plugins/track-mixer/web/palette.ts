import { useConfig } from "@plugins/config_v2/web";
import {
  asSonataLook,
  SONATA_LOOK_STYLES,
  sonataLookConfig,
} from "@plugins/apps/plugins/sonata/plugins/look/core";

/**
 * Track colours. Each track defaults to a colour by its index in
 * `score.tracks`, from the active LOOK's track palette (`SonataLookStyle.tracks`
 * — Synthesia's under the flat looks, the night stage's under `immersive`); the
 * user can override the base per track. Cycles if a score has more tracks than
 * colours.
 *
 * Under a look that shades accidentals (`notes.accidentalShade`), a note on a
 * black key wears its track colour's darker, slightly more saturated partner —
 * Synthesia's natural/sharp distinction — via {@link accidentalColor}; the
 * white-key shade is the track's "base" colour. Under one that does not, every
 * note of a track is the same colour.
 */
export interface TrackColorLook {
  /** The look's palette: the defaults by index, and the swatch picker's choices. */
  palette: readonly string[];
  /** The default colour of the track at `index`. */
  defaultColor: (index: number) => string;
  /** The colour a note on a black key wears, for a track's base colour. */
  accidental: (base: string) => string;
}

const sameColor = (base: string) => base;

/** The active look's track colours — see {@link TrackColorLook}. */
export function useTrackColorLook(): TrackColorLook {
  const style =
    SONATA_LOOK_STYLES[asSonataLook(useConfig(sonataLookConfig).look)];
  const palette = style.tracks;
  return {
    palette,
    defaultColor: (index) => palette[index % palette.length]!,
    accidental: style.notes.accidentalShade ? accidentalColor : sameColor,
  };
}

/**
 * Exact black-key partners for the colors Synthesia ships (sampled from its
 * render). Other base colors fall through to {@link deriveAccidental}.
 */
const EXACT_ACCIDENTAL: Record<string, string> = {
  "#87aacf": "#376bae", // blue
  "#a2e55b": "#569d10", // green
};

/**
 * The black-key (sharp/flat) shade for a given base color — Synthesia's
 * natural-vs-accidental distinction. Returns the sampled-exact partner for the
 * built-in Synthesia colors, and otherwise darkens + slightly saturates the
 * base (the relationship the exact pairs share). Non-hex inputs (e.g. the
 * `var(--primary)` no-track fallback) are returned unchanged.
 */
function accidentalColor(base: string): string {
  const key = base.trim().toLowerCase();
  return EXACT_ACCIDENTAL[key] ?? deriveAccidental(key);
}

// --- color math ----------------------------------------------------------------

function deriveAccidental(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex; // not a #rrggbb literal — leave as-is (white === black)
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  // Black keys read darker and a touch more saturated than their white-key twin.
  const [r, g, b] = hslToRgb(h, Math.min(1, s + 0.09), l * 0.6);
  return rgbToHex(r, g, b);
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((((g - b) / d) % 6) + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}
