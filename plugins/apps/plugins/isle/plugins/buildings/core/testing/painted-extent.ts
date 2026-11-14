// A measuring 2D context: it draws nothing, it records WHERE a painter puts
// ink, so a footprint test runs under bun:test, which has no canvas. Bounds are
// conservative — a path's box is the hull of its points and control points, a
// stroke is widened by half its width (twice that for a miter join) — so a
// painter that passes here stays inside its box on a real canvas too.
// A `lighter` draw is a GLOW (a beam, a forge's flicker, a beacon's halo), not
// ink: it is not measured — the renderer's hit masks ignore it the same way,
// and a lighthouse's beam must not claim the plot it sweeps.

import type { Box, Ctx2D } from "../spec";

/** A 2D affine transform `[a, b, c, d, e, f]` (canvas order). */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

type MutBox = [number, number, number, number];

const emptyBox = (): MutBox => [Infinity, Infinity, -Infinity, -Infinity];
const isEmpty = (b: MutBox) => b[0] > b[2] || b[1] > b[3];

function grow(b: MutBox, x: number, y: number): void {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}

function intersect(a: MutBox, b: MutBox): MutBox {
  return [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
}

interface DrawState {
  m: Matrix;
  clip: MutBox | null;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  composite: GlobalCompositeOperation;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

/** Stub gradient / pattern: accepts colour stops, paints nothing on its own. */
const STUB_GRADIENT = { addColorStop() {} };

/** Ops that paint only where ink already is (or remove ink): they never grow it. */
const NON_GROWING: ReadonlySet<string> = new Set([
  "source-atop",
  "source-in",
  "destination-in",
  "destination-out",
  "destination-atop",
]);

class MeasuringContext {
  private state: DrawState = {
    m: [...IDENTITY],
    clip: null,
    lineWidth: 1,
    lineJoin: "miter",
    globalAlpha: 1,
    composite: "source-over",
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
  private stack: DrawState[] = [];
  private path: MutBox = emptyBox();
  private readonly marks: MutBox[] = [];

  fillStyle: unknown = "#000";
  strokeStyle: unknown = "#000";
  lineCap: CanvasLineCap = "butt";
  miterLimit = 10;
  letterSpacing = "0px";
  filter = "none";
  shadowBlur = 0;
  shadowColor = "rgba(0,0,0,0)";
  imageSmoothingEnabled = true;

  /** Every painted box, in the caller's (untransformed) coordinates. */
  get painted(): readonly Box[] {
    return this.marks;
  }

  // ---- state ----
  get lineWidth() {
    return this.state.lineWidth;
  }
  set lineWidth(v: number) {
    this.state.lineWidth = v;
  }
  get lineJoin() {
    return this.state.lineJoin;
  }
  set lineJoin(v: CanvasLineJoin) {
    this.state.lineJoin = v;
  }
  get globalAlpha() {
    return this.state.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.state.globalAlpha = v;
  }
  get globalCompositeOperation() {
    return this.state.composite;
  }
  set globalCompositeOperation(v: GlobalCompositeOperation) {
    this.state.composite = v;
  }
  get font() {
    return this.state.font;
  }
  set font(v: string) {
    this.state.font = v;
  }
  get textAlign() {
    return this.state.textAlign;
  }
  set textAlign(v: CanvasTextAlign) {
    this.state.textAlign = v;
  }
  get textBaseline() {
    return this.state.textBaseline;
  }
  set textBaseline(v: CanvasTextBaseline) {
    this.state.textBaseline = v;
  }

  save(): void {
    this.stack.push({
      ...this.state,
      m: [...this.state.m],
      clip: this.state.clip ? [...this.state.clip] : null,
    });
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) this.state = s;
  }

  // ---- transform ----
  translate(x: number, y: number): void {
    this.state.m = multiply(this.state.m, [1, 0, 0, 1, x, y]);
  }
  scale(x: number, y: number): void {
    this.state.m = multiply(this.state.m, [x, 0, 0, y, 0, 0]);
  }
  rotate(a: number): void {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.state.m = multiply(this.state.m, [c, s, -s, c, 0, 0]);
  }
  transform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void {
    this.state.m = multiply(this.state.m, [a, b, c, d, e, f]);
  }
  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void {
    this.state.m = [a, b, c, d, e, f];
  }
  resetTransform(): void {
    this.state.m = [...IDENTITY];
  }

  private dev(x: number, y: number): [number, number] {
    const m = this.state.m;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  private add(x: number, y: number): void {
    const [dx, dy] = this.dev(x, y);
    grow(this.path, dx, dy);
  }
  /** How much the transform stretches a length, at most: its largest singular value. */
  private stretch(): number {
    const [a, b, c, d] = this.state.m;
    const S = a * a + b * b + c * c + d * d;
    const det = a * d - b * c;
    return Math.sqrt((S + Math.sqrt(Math.max(0, S * S - 4 * det * det))) / 2);
  }

  // ---- paths ----
  beginPath(): void {
    this.path = emptyBox();
  }
  closePath(): void {}
  moveTo(x: number, y: number): void {
    this.add(x, y);
  }
  lineTo(x: number, y: number): void {
    this.add(x, y);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.add(cx, cy);
    this.add(x, y);
  }
  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void {
    this.add(c1x, c1y);
    this.add(c2x, c2y);
    this.add(x, y);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.add(x, y);
    this.add(x + w, y);
    this.add(x, y + h);
    this.add(x + w, y + h);
  }
  roundRect(x: number, y: number, w: number, h: number): void {
    this.rect(x, y, w, h);
  }
  arc(
    x: number,
    y: number,
    r: number,
    a0: number,
    a1: number,
    ccw = false,
  ): void {
    this.ellipse(x, y, r, r, 0, a0, a1, ccw);
  }
  ellipse(
    x: number,
    y: number,
    rx: number,
    ry: number,
    rot: number,
    a0: number,
    a1: number,
    ccw = false,
  ): void {
    // (The line a canvas draws from the current point to the arc is inside the hull: both ends are in it.)
    let span = ccw ? a0 - a1 : a1 - a0;
    if (span >= Math.PI * 2 || span <= -Math.PI * 2) span = Math.PI * 2;
    else span = ((span % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const dir = ccw ? -1 : 1;
    const n = 96;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    // Sampling a convex arc misses at most r·(1 − cos(π/n)): pad by that.
    const pad =
      Math.max(Math.abs(rx), Math.abs(ry)) * (1 - Math.cos(Math.PI / n)) * 1.01;
    for (let i = 0; i <= n; i++) {
      const a = a0 + dir * span * (i / n);
      const ex = Math.cos(a) * rx;
      const ey = Math.sin(a) * ry;
      const px = x + ex * cr - ey * sr;
      const py = y + ex * sr + ey * cr;
      for (const [ox, oy] of [
        [-pad, -pad],
        [pad, pad],
      ] as const) {
        this.add(px + ox, py + oy);
      }
    }
  }

  // ---- painting ----
  private mark(b: MutBox): void {
    if (isEmpty(b) || this.state.globalAlpha <= 0) return;
    if (NON_GROWING.has(this.state.composite)) return;
    if (this.state.composite === "lighter") return; // a glow, not ink
    const clipped = this.state.clip ? intersect(b, this.state.clip) : b;
    if (isEmpty(clipped)) return;
    this.marks.push(clipped);
  }
  private strokePad(): number {
    const w = this.state.lineWidth / 2;
    // A miter join reaches w / sin(θ/2) out: 2w covers every corner of 60° or more.
    return (this.state.lineJoin === "miter" ? 2 * w : w) * this.stretch();
  }
  fill(): void {
    this.mark([...this.path]);
  }
  stroke(): void {
    const p = this.strokePad();
    const b = this.path;
    this.mark([b[0] - p, b[1] - p, b[2] + p, b[3] + p]);
  }
  clip(): void {
    const b: MutBox = [...this.path];
    this.state.clip = this.state.clip ? intersect(this.state.clip, b) : b;
  }
  private boxOf(x: number, y: number, w: number, h: number): MutBox {
    const b = emptyBox();
    for (const [px, py] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ] as const) {
      const [dx, dy] = this.dev(px, py);
      grow(b, dx, dy);
    }
    return b;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.mark(this.boxOf(x, y, w, h));
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    const b = this.boxOf(x, y, w, h);
    const p = this.strokePad();
    this.mark([b[0] - p, b[1] - p, b[2] + p, b[3] + p]);
  }
  clearRect(): void {}
  private textBox(text: string, x: number, y: number): MutBox {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.state.font)?.[1] ?? 10);
    const w = text.length * size * 0.7;
    const align = this.state.textAlign;
    const x0 =
      align === "center"
        ? x - w / 2
        : align === "right" || align === "end"
          ? x - w
          : x;
    const base = this.state.textBaseline;
    const y0 =
      base === "middle"
        ? y - size * 0.6
        : base === "top" || base === "hanging"
          ? y
          : y - size;
    return this.boxOf(x0, y0, w, size * 1.25);
  }
  fillText(text: string, x: number, y: number): void {
    this.mark(this.textBox(text, x, y));
  }
  strokeText(text: string, x: number, y: number): void {
    const b = this.textBox(text, x, y);
    const p = this.strokePad();
    this.mark([b[0] - p, b[1] - p, b[2] + p, b[3] + p]);
  }
  measureText(text: string): { width: number } {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.state.font)?.[1] ?? 10);
    return { width: text.length * size * 0.7 };
  }
  drawImage(_img: unknown, ...a: number[]): void {
    const [x, y, w, h] =
      a.length >= 8
        ? a.slice(4, 8)
        : a.length >= 4
          ? a
          : [a[0] ?? 0, a[1] ?? 0, 0, 0];
    this.mark(this.boxOf(x ?? 0, y ?? 0, w ?? 0, h ?? 0));
  }
  createLinearGradient(): typeof STUB_GRADIENT {
    return STUB_GRADIENT;
  }
  createRadialGradient(): typeof STUB_GRADIENT {
    return STUB_GRADIENT;
  }
  createConicGradient(): typeof STUB_GRADIENT {
    return STUB_GRADIENT;
  }
  createPattern(): typeof STUB_GRADIENT {
    return STUB_GRADIENT;
  }
  setLineDash(): void {}
  getLineDash(): number[] {
    return [];
  }
}

/** Where a painter put ink, split at a horizontal line. */
export interface PaintedExtent {
  /** The ink at y ≥ splitY (the ground band), or null when none. */
  readonly below: Box | null;
  /** The ink above splitY, or null when none. */
  readonly above: Box | null;
}

/**
 * Runs `draw` against a measuring context (no canvas needed) and returns where
 * it put ink, in the coordinates `draw` starts in, split at `splitY`. A
 * building's footprint test checks `below` against `footprint.ground` and
 * `above` against `footprint.upper`, with `splitY = -GROUND_BAND`.
 */
export function paintedExtent(
  draw: (g: Ctx2D) => void,
  splitY: number,
): PaintedExtent {
  const ctx = new MeasuringContext();
  // The measuring context implements the subset of the 2D API painters use;
  // anything else throws, which names the method to add here.
  const g = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      throw new Error(
        `paintedExtent: the measuring context has no "${String(prop)}"`,
      );
    },
  }) as unknown as Ctx2D;
  draw(g);
  const below = emptyBox();
  const above = emptyBox();
  for (const b of ctx.painted) {
    if (b[3] > splitY) {
      grow(below, b[0], Math.max(b[1], splitY));
      grow(below, b[2], b[3]);
    }
    if (b[1] < splitY) {
      grow(above, b[0], b[1]);
      grow(above, b[2], Math.min(b[3], splitY));
    }
  }
  return {
    below: isEmpty(below) ? null : below,
    above: isEmpty(above) ? null : above,
  };
}

/** Whether `inner` lies inside `outer`, give or take `tolerance` px on each side. */
export function boxWithin(inner: Box, outer: Box, tolerance = 0): boolean {
  return (
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  );
}
