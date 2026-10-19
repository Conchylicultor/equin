import {
  isAccidental,
  type PitchColumn,
  type PitchGuide,
  type PitchKey,
} from "@plugins/apps/plugins/sonata/plugins/score/core";
import type { PitchLayout } from "./geometry";

/**
 * The 88-key piano, as fractions.
 *
 * Naturals tile the width edge-to-edge (`whiteW = 1 / naturalCount`) and each
 * accidental centers on the boundary just above its lower natural neighbour,
 * drawn narrower and shorter. This is the formula Sonata has always drawn,
 * moved here verbatim from the keyboard primitive's `key-layout.ts` — under
 * `piano` the roll must stay pixel-identical, so the arithmetic is unchanged,
 * not merely equivalent.
 */

/** Accidentals are this fraction of a natural's width — and of its height. */
const BLACK_WIDTH_RATIO = 0.62;

/**
 * How far down the keybed an accidental reaches. It is the SAME 0.62 as the
 * width ratio by coincidence of taste, not by construction, so it is spelled
 * separately.
 *
 * There is no `BLACK_KEY_HEIGHT_PCT` any more: a pad's own `height` is the one
 * source every renderer reads (the div's box and the drawn skin's path alike),
 * so decorative art can no longer drift off the box that hit-tests for it.
 */
const BLACK_HEIGHT_RATIO = 0.62;

/**
 * A natural's length over its width — a real white key is ~23.5mm wide and
 * ~100mm+ long; 4.4 is the shorter, chip-friendly proportion Sonata draws.
 */
const WHITE_KEY_LENGTH = 4.4;

/**
 * Widen outward while an endpoint is an accidental, so the row starts and ends
 * on a natural and therefore tiles flush.
 *
 * The identity on every range Sonata actually asks for — 21..108 (A0..C8, the
 * full keyboard) and 60..95 (the readout chips' three octaves) — which is what
 * keeps `piano` pixel-identical to the layout this replaces.
 */
function snapRange(low: number, high: number): { low: number; high: number } {
  let lo = low;
  let hi = high;
  while (isAccidental(lo)) lo -= 1;
  while (isAccidental(hi)) hi += 1;
  return { low: lo, high: hi };
}

/** One key-width per natural; the keyboard is `WHITE_KEY_LENGTH` of them tall. */
function proportion(
  low: number,
  high: number,
): { span: number; aspect: number } {
  let span = 0;
  for (let pitch = low; pitch <= high; pitch++) {
    if (!isAccidental(pitch)) span += 1;
  }
  return { span, aspect: span / WHITE_KEY_LENGTH };
}

function lay(
  low: number,
  high: number,
): { keys: PitchKey[]; columns: PitchColumn[]; guides: PitchGuide[] } {
  let naturalCount = 0;
  for (let pitch = low; pitch <= high; pitch++) {
    if (!isAccidental(pitch)) naturalCount += 1;
  }
  if (naturalCount === 0) return { keys: [], columns: [], guides: [] };

  const whiteW = 1 / naturalCount;
  const blackW = whiteW * BLACK_WIDTH_RATIO;

  // Pads are emitted ascending by TIER then pitch (the plane's declared order),
  // so the renderer can slice contiguous tiers off one array and paint them in
  // paint order. Naturals are tier 0, accidentals tier 1 — the accidentals ride
  // over the naturals they sit between.
  const naturals: PitchKey[] = [];
  const accidentals: PitchKey[] = [];
  const columns: PitchColumn[] = [];

  let naturalIndex = 0;
  for (let pitch = low; pitch <= high; pitch++) {
    if (!isAccidental(pitch)) {
      const key: PitchKey = {
        pitch,
        center: naturalIndex * whiteW + whiteW / 2,
        width: whiteW,
        top: 0,
        height: 1,
        tier: 0,
      };
      naturals.push(key);
      naturalIndex += 1;
      columns.push({ pitch, center: key.center, width: key.width });
    } else {
      // The boundary between the natural just below and the next one.
      const key: PitchKey = {
        pitch,
        center: naturalIndex * whiteW,
        width: blackW,
        top: 0,
        height: BLACK_HEIGHT_RATIO,
        tier: 1,
      };
      accidentals.push(key);
      // A note column IS the pad on the piano: a falling accidental is exactly
      // as wide as the black key it lands on.
      columns.push({ pitch, center: key.center, width: key.width });
    }
  }

  // Orientation rules at the two natural-natural boundaries — the ones with no
  // accidental between them. The octave split (left edge of every C) reads
  // STRONG; the mid-octave E–F split reads weak.
  const guides: PitchGuide[] = columns
    .filter((c) => {
      const pc = ((c.pitch % 12) + 12) % 12;
      return pc === 0 || pc === 5;
    })
    .map((c) => ({
      frac: c.center - c.width / 2,
      strong: ((c.pitch % 12) + 12) % 12 === 0,
    }));

  return { keys: [...naturals, ...accidentals], columns, guides };
}

export const pianoLayout: PitchLayout = {
  snapRange,
  lay,
  proportion,
  // The immersive player's keybed (proto-1792113547-2qr6g7): low enough that
  // the notes keep most of the window.
  heights: { keybed: 92 },
};
