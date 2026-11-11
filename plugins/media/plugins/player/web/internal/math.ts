import { SLIM } from "./geometry";

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** `m:ss`, or `h:mm:ss` past an hour. A time not known yet reads `0:00`. */
export function formatTime(seconds: number): string {
  const t = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const head = h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}`;
  return `${head}:${String(s).padStart(2, "0")}`;
}

/** Where a pointer at `x` falls along a track spanning `[left, left + width]`, as 0–1. */
export function fractionAt(x: number, left: number, width: number): number {
  if (width <= 0) return 0;
  return clamp((x - left) / width, 0, 1);
}

/**
 * The end of the buffered range the playhead is in (or just before: a range
 * starting within half a second ahead still counts), so the bar shows what
 * will play next without a seek — not some far range a past seek loaded.
 */
export function bufferedEnd(
  ranges: { length: number; start(i: number): number; end(i: number): number },
  currentTime: number,
): number {
  let end = 0;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= currentTime + 0.5)
      end = Math.max(end, ranges.end(i));
  }
  return end;
}

// ── Volume ──────────────────────────────────────────────────────────────

/** One wheel notch or arrow press on the volume capsule. */
export const VOLUME_STEP = 0.05;
/** One ↑ / ↓ press anywhere on the player. */
export const VOLUME_KEY_STEP = 0.1;

/** What the volume reads as: muted reads 0, whatever level it will come back to. */
export function audibleVolume(volume: number, muted: boolean): number {
  return muted ? 0 : volume;
}

/** Setting a level: 0 is muted, anything else unmuted, clamped to the range. */
export function volumeTarget(v: number): { volume: number; muted: boolean } {
  const volume = clamp(v, 0, 1);
  return { volume, muted: volume === 0 };
}

/**
 * The mute button: mute when sound is on; when off (muted, or turned down to
 * nothing), unmute — at half volume if the level itself was 0, so unmuting is
 * never silent.
 */
export function toggleMute(
  volume: number,
  muted: boolean,
): { volume: number; muted: boolean } {
  if (muted || volume === 0)
    return { volume: volume === 0 ? 0.5 : volume, muted: false };
  return { volume, muted: true };
}

/** The speaker glyph for a level. */
export function volumeGlyph(v: number): "off" | "down" | "up" {
  return v === 0 ? "off" : v < 0.5 ? "down" : "up";
}

// ── Speed ───────────────────────────────────────────────────────────────

export const RATE_MIN = 0.25;
export const RATE_MAX = 3;
export const RATE_STEP = 0.05;
/** The chips under the dial. */
export const RATE_PRESETS = [0.5, 1, 1.5, 2] as const;
/** `<` / `>` change the speed by this much. */
export const RATE_KEY_STEP = 0.25;
/** Pixels of ruler per step of the dial: 12px at the regular size, scaled. */
export const DIAL_PX_PER_STEP = 12 * SLIM.k;

const EPS = 1e-6;

/** The speed, kept within the dial's range. */
export function clampRate(r: number): number {
  return clamp(r, RATE_MIN, RATE_MAX);
}

/** The nearest step of the dial, within its range, rounded clean (no 1.1500000002). */
export function snapRate(r: number): number {
  return +(Math.round(clampRate(r) / RATE_STEP) * RATE_STEP).toFixed(3);
}

/** The same speed, give or take float noise. */
export function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

/** The ruler's offset under the fixed centre needle for a speed (px; 0 at the minimum). */
export function rulerOffset(rate: number): number {
  return ((RATE_MIN - rate) / RATE_STEP) * DIAL_PX_PER_STEP;
}

/** Dragging the ruler: moving it right by `dx` slides lower speeds under the needle. Unsnapped. */
export function dragRate(startRate: number, dx: number): number {
  return clampRate(startRate - (dx / DIAL_PX_PER_STEP) * RATE_STEP);
}

/** A click on the ruler picks the speed under the pointer (`dx` from the needle), snapped. */
export function clickRate(rate: number, dx: number): number {
  return snapRate(rate + (dx / DIAL_PX_PER_STEP) * RATE_STEP);
}

/** A wheel over the dial: half a step per ruler pixel of delta, unsnapped (it settles after). */
export function wheelRate(
  rate: number,
  deltaX: number,
  deltaY: number,
): number {
  const d = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  return clampRate(rate + (d / DIAL_PX_PER_STEP) * RATE_STEP * 0.5);
}

/** The dial's keys: arrows step, Home / End jump to the ends. `null` = not the dial's key. */
export function keyRate(rate: number, key: string): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return snapRate(rate + RATE_STEP);
    case "ArrowLeft":
    case "ArrowDown":
      return snapRate(rate - RATE_STEP);
    case "Home":
      return RATE_MIN;
    case "End":
      return RATE_MAX;
    default:
      return null;
  }
}

/** How a speed is read out: always two decimals in the panel (`1.25×`), shortest on a badge (`1.25×`, `2×`). */
export function rateReadout(rate: number): string {
  return `${rate.toFixed(2)}×`;
}
export function rateShort(rate: number): string {
  return `${+rate.toFixed(2)}×`;
}

export interface DialTick {
  rate: number;
  /** Offset from the ruler's start, px. */
  x: number;
  /** Majors every 0.5 (labelled), mids every 0.25, a minor at every step. */
  kind: "major" | "mid" | "minor";
}

/** Every tick of the ruler, minimum to maximum. */
export function dialTicks(): DialTick[] {
  const ticks: DialTick[] = [];
  const n = Math.round((RATE_MAX - RATE_MIN) / RATE_STEP);
  for (let i = 0; i <= n; i++) {
    const rate = +(RATE_MIN + i * RATE_STEP).toFixed(2);
    const major = Math.abs(rate * 2 - Math.round(rate * 2)) < EPS;
    const mid = !major && Math.abs(rate * 4 - Math.round(rate * 4)) < EPS;
    ticks.push({
      rate,
      x: i * DIAL_PX_PER_STEP,
      kind: major ? "major" : mid ? "mid" : "minor",
    });
  }
  return ticks;
}

// ── Time ────────────────────────────────────────────────────────────────

/** ← / → skip this many seconds. */
export const SKIP_SECONDS = 5;

/** A skip, kept within the media. */
/**
 * How far an arrow key skips at a playback rate: `SKIP_SECONDS` of
 * *watching*, so of media time scaled by the rate — at 0.25× a press goes
 * back 1.25 s (not 20 s of what you watched), at 2× it goes 10 s.
 */
export function skipSeconds(rate: number): number {
  return SKIP_SECONDS * rate;
}

export function skipTarget(
  current: number,
  delta: number,
  duration: number,
): number {
  return clamp(current + delta, 0, Number.isFinite(duration) ? duration : 0);
}

/**
 * The seek bar's own keys while it has focus (a slider's keys): ← ↓ and → ↑
 * step 5 s of watching (`skipSeconds`), Page Down / Page Up a tenth of the media, Home / End its ends.
 * `null` = not the seek bar's key.
 */
export function seekKeyTarget(
  key: string,
  current: number,
  duration: number,
  rate: number,
): number | null {
  const d = Number.isFinite(duration) ? duration : 0;
  const step = skipSeconds(rate);
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return skipTarget(current, -step, d);
    case "ArrowRight":
    case "ArrowUp":
      return skipTarget(current, step, d);
    case "PageDown":
      return skipTarget(current, -d / 10, d);
    case "PageUp":
      return skipTarget(current, d / 10, d);
    case "Home":
      return 0;
    case "End":
      return d;
    default:
      return null;
  }
}

/** The digit keys: `n` jumps to n tenths of the way through. */
export function digitTarget(digit: number, duration: number): number {
  return Number.isFinite(duration) ? (digit / 10) * duration : 0;
}
