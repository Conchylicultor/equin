/**
 * CSS color expression → packed 0xRRGGBB resolver for the canvas renderer.
 *
 * Track colors arrive as CSS STRINGS — the defaults are theme tokens like
 * `var(--categorical-3)` — but a GPU renderer needs numbers. The browser is the
 * only correct CSS evaluator (tokens cascade, themes flip, colors may be
 * authored in oklch), so we let IT do the work: a hidden probe element gets
 * `style.color = expr` and we parse `getComputedStyle(...).color` back.
 *
 * Browsers serialize the computed color in one of three families: the legacy
 * `rgb()`/`rgba()` form, `color(srgb r g b)`, or — per CSS Color 4, the form
 * Chrome actually emits for our oklch-authored theme tokens — the ORIGINAL
 * color space (`oklch(L C H)` / `oklab(L a b)`). `parseComputedColor` handles
 * all of them (including the OKLab→sRGB conversion math) and is deliberately
 * PURE (no `document` access) so it unit-tests under plain `bun test`; only
 * `resolveCssColor` / `watchThemeColors` touch the DOM, and only when called.
 *
 * Fail-loud rule: an unparseable serialization or an expression the browser
 * rejected THROWS with the offending string — a silently-black piano roll
 * would hide the structural bug (a new serialization form, a typoed token).
 *
 * Kept local to piano-roll; promote to a shared primitive only when a second
 * consumer appears (see the plan's follow-ups).
 */

/** Clamp + round one sRGB channel to a byte, accepting 0–255 floats. */
function byteOf255(raw: string): number {
  return Math.max(0, Math.min(255, Math.round(Number(raw))));
}

/** Clamp + round one sRGB channel to a byte, accepting 0–1 floats. */
function byteOf1(raw: string): number {
  return Math.max(0, Math.min(255, Math.round(Number(raw) * 255)));
}

// Computed-style serializations only — this is NOT a general CSS color parser.
// `rgb(r, g, b)` / `rgba(r, g, b, a)`: channels are 0–255 (floats allowed).
const RGB_RE =
  /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)$/;
// `color(srgb r g b)` / `color(srgb r g b / a)`: channels are 0–1 floats.
const SRGB_RE =
  /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+\s*)?\)$/;
// `oklch(L C H)` / `oklab(L a b)` (+ optional `/ a`): per CSS Color 4 the
// computed value of an oklch-authored color KEEPS its color space, and our
// theme tokens are authored in oklch — so this is the serialization Chrome
// actually hands back for `var(--categorical-N)` & friends. Channels are
// numbers (possibly negative for oklab a/b, signless for L/C), the hue may
// carry a `deg` suffix, and achromatic colors may serialize a channel as the
// `none` keyword.
const OKLCH_RE =
  /^oklch\(\s*(none|-?[\d.]+%?)\s+(none|-?[\d.]+)\s+(none|-?[\d.]+(?:deg)?)\s*(?:\/\s*[\d.%]+\s*)?\)$/;
const OKLAB_RE =
  /^oklab\(\s*(none|-?[\d.]+%?)\s+(none|-?[\d.]+)\s+(none|-?[\d.]+)\s*(?:\/\s*[\d.%]+\s*)?\)$/;

/** Parse one oklch/oklab channel: `none` ⇒ 0, `%` ⇒ /100, `deg` stripped. */
function oklabChannel(raw: string): number {
  if (raw === "none") return 0;
  if (raw.endsWith("%")) return Number(raw.slice(0, -1)) / 100;
  if (raw.endsWith("deg")) return Number(raw.slice(0, -3));
  return Number(raw);
}

/** Linear-light sRGB channel → gamma-encoded byte (clamped). */
function gammaByte(linear: number): number {
  const c = Math.max(0, Math.min(1, linear));
  const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(srgb * 255)));
}

/**
 * OKLab → packed sRGB, gamut-clipped per channel. The two matrices are the
 * reference ones from Björn Ottosson's OKLab definition (the same constants
 * the CSS Color 4 spec uses): OKLab → non-linear LMS (cubed to linear LMS) →
 * linear sRGB → gamma encode.
 */
function oklabToPacked(L: number, a: number, b: number): number {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return (gammaByte(rLin) << 16) | (gammaByte(gLin) << 8) | gammaByte(bLin);
}

/**
 * Parse a COMPUTED-style color serialization into packed 0xRRGGBB. Alpha is
 * ignored — the renderer carries opacity separately. Returns
 * null for anything that isn't one of the known computed forms; the caller
 * decides whether that's fatal (it is, in `resolveCssColor`). Pure.
 */
export function parseComputedColor(s: string): number | null {
  const input = s.trim();
  const rgb = RGB_RE.exec(input);
  if (rgb) {
    return (byteOf255(rgb[1]!) << 16) | (byteOf255(rgb[2]!) << 8) | byteOf255(rgb[3]!);
  }
  const srgb = SRGB_RE.exec(input);
  if (srgb) {
    return (byteOf1(srgb[1]!) << 16) | (byteOf1(srgb[2]!) << 8) | byteOf1(srgb[3]!);
  }
  const oklch = OKLCH_RE.exec(input);
  if (oklch) {
    const L = oklabChannel(oklch[1]!);
    const C = oklabChannel(oklch[2]!);
    const H = (oklabChannel(oklch[3]!) * Math.PI) / 180;
    return oklabToPacked(L, C * Math.cos(H), C * Math.sin(H));
  }
  const oklab = OKLAB_RE.exec(input);
  if (oklab) {
    return oklabToPacked(
      oklabChannel(oklab[1]!),
      oklabChannel(oklab[2]!),
      oklabChannel(oklab[3]!),
    );
  }
  return null;
}

// One probe per host element, created lazily on first resolve (NOT at module
// load — this module must stay importable in DOM-less environments like
// `bun test`). It lives INSIDE the element whose colours it resolves, so the
// tokens it reads are that region's — its app's theme, in its app's scheme
// (the nearest `data-color-scheme` carrier) — not `<html>`'s, which is the
// desktop's. Fully inert: hidden, zero footprint, no pointer events.
const probes = new WeakMap<Element, HTMLDivElement>();

function getProbe(host: Element): HTMLDivElement {
  const existing = probes.get(host);
  if (existing && existing.isConnected) return existing;
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = "0";
  probe.style.height = "0";
  host.appendChild(probe);
  probes.set(host, probe);
  return probe;
}

/**
 * Resolve any CSS color EXPRESSION (`var(--primary)`, `oklch(…)`, `#abc`, …)
 * to packed 0xRRGGBB via the browser's own evaluator, as it computes inside
 * `host` (the region's tokens and scheme). Throws — never returns a
 * silent black — when the expression doesn't parse as a color at all, or when
 * its computed serialization is a form `parseComputedColor` doesn't know.
 */
export function resolveCssColor(expr: string, host: Element): number {
  const el = getProbe(host);
  // Reset-then-set: an invalid value leaves the property untouched, so an
  // empty `style.color` after assignment means the browser REJECTED the
  // expression — surface that instead of reading a stale/inherited color.
  el.style.color = "";
  el.style.color = expr;
  if (el.style.color === "") {
    throw new Error(
      `resolveCssColor: ${JSON.stringify(expr)} is not a valid CSS color expression (the browser rejected it)`,
    );
  }
  const computed = getComputedStyle(el).color;
  const parsed = parseComputedColor(computed);
  if (parsed === null) {
    throw new Error(
      `resolveCssColor: computed color ${JSON.stringify(computed)} for ${JSON.stringify(expr)} ` +
        `is not a recognized serialization (expected rgb()/rgba()/color(srgb …)) — teach parseComputedColor the new form`,
    );
  }
  return parsed;
}
