/**
 * The emoji fonts frimousse draws its grid with (its own stack), so the probe
 * asks about the glyphs the picker will actually show.
 */
const EMOJI_FONTS =
  "'Apple Color Emoji', 'Noto Color Emoji', 'Twemoji Mozilla', 'Android Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', EmojiSymbols, sans-serif";

/** A flag every font that draws flags draws. */
const PROBE = "🇪🇺";
/** The probe canvas's side, in px. */
const SIDE = 2;

let drawn: boolean | null = null;

/**
 * Whether this browser's fonts draw a country flag as one colour glyph — on
 * Windows they draw two regional-indicator letters instead, so the picker
 * leaves flags out there, as frimousse's own resolver does (this is its
 * probe): a glyph wider than the box is two letters, and a glyph whose pixels
 * follow the fill colour is a monochrome text glyph, not a colour emoji.
 * Probed once per page.
 */
export function drawsCountryFlags(): boolean {
  if (drawn !== null) return drawn;
  const ctx = document
    .createElement("canvas")
    .getContext("2d", { willReadFrequently: true });
  // No 2D canvas: the browser cannot say, so flags are left out — what
  // frimousse does too.
  if (ctx === null) return (drawn = false);
  ctx.canvas.width = SIDE;
  ctx.canvas.height = SIDE;
  ctx.font = `${SIDE}px ${EMOJI_FONTS}`;
  ctx.textBaseline = "middle";
  if (ctx.measureText(PROBE).width >= SIDE * 2) return (drawn = false);
  const pixels = (fill: string) => {
    ctx.clearRect(0, 0, SIDE, SIDE);
    ctx.fillStyle = fill;
    ctx.fillText(PROBE, 0, 0);
    return ctx.getImageData(0, 0, SIDE, SIDE).data;
  };
  const blue = pixels("#00f");
  const red = pixels("#f00");
  for (let i = 0; i < blue.length; i += 4) {
    if (
      blue[i] !== red[i] ||
      blue[i + 1] !== red[i + 1] ||
      blue[i + 2] !== red[i + 2]
    )
      return (drawn = false);
  }
  return (drawn = true);
}
