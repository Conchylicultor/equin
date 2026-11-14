// Buildings as the renderer holds them: each painted once (per time of day)
// into its own canvas at 2×, an LRU keeping the pixel count bounded; its hit
// mask (what the pointer hits is its drawn shape, not its box); and its hover
// art — a warm rim light round the silhouette and a wash of light on it.

import type {
  Box,
  BuildingSpec,
  PaintState,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";
import type { Pt } from "@plugins/apps/plugins/isle/plugins/world/core";
import { canvas, ctx2d, type Ctx } from "./kit";
import { MASK_C, MASK_DIL, maskFromAlpha, type Mask } from "./hit-mask";

const MASK_A_ANIM = 140;
export const HALO_P = 16;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** One building on the map. */
export interface SceneBuilding {
  /** Stable while the app stands on the same plot facing the same way. */
  readonly key: string;
  readonly appId: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** What it may paint, door-relative (its declared footprint). */
  readonly bounds: Box;
  readonly spec: BuildingSpec;
  readonly w: number;
  readonly depth: number;
  readonly signX: number;
  readonly signHalf: number;
  readonly door: Pt;
  /** The live paint state handed to `animate` (t and open move). */
  readonly state: Mutable<PaintState>;
  /** A fresh paint state for a static paint (its stream restarted). */
  readonly fresh: () => PaintState;
}

/** A building's bounds: its declared footprint (ground and upper), a little slack round it. */
export function boundsOf(spec: BuildingSpec): Box {
  const { ground: g, upper: u } = spec.footprint;
  return [
    Math.floor(Math.min(g[0], u ? u[0] : g[0]) - 4),
    Math.floor(Math.min(g[1], u ? u[1] : g[1]) - 4),
    Math.ceil(Math.max(g[2], u ? u[2] : g[2]) + 4),
    Math.ceil(g[3] + 4),
  ];
}

/** A 2D context whose glow draws (`lighter`: forge flicker, beams, light spill) are no-ops — glows never hit. */
function glowless(
  c: HTMLCanvasElement,
  opts?: CanvasRenderingContext2DSettings,
): Ctx {
  const cg = ctx2d(c, opts);
  const P = CanvasRenderingContext2D.prototype;
  const wrap = <
    K extends
      | "fill"
      | "stroke"
      | "fillRect"
      | "strokeRect"
      | "fillText"
      | "strokeText"
      | "drawImage",
  >(
    k: K,
  ) => {
    const f = P[k] as (...a: unknown[]) => void;
    Object.defineProperty(cg, k, {
      value: function (this: Ctx, ...a: unknown[]) {
        if (this.globalCompositeOperation !== "lighter") f.apply(this, a);
      },
    });
  };
  for (const k of [
    "fill",
    "stroke",
    "fillRect",
    "strokeRect",
    "fillText",
    "strokeText",
    "drawImage",
  ] as const)
    wrap(k);
  return cg;
}

interface Baked {
  readonly c: HTMLCanvasElement;
  readonly px: number;
  used: number;
}

interface HoverArt {
  readonly halo: HTMLCanvasElement;
  readonly lit: HTMLCanvasElement;
  readonly sil: HTMLCanvasElement;
  readonly W: number;
  readonly H: number;
}

const BAKE_BUDGET = 70e6;
const BAKE_KEEP = 50e6;

/** Reads a painted building's hit mask elsewhere (a bake worker); `null` when it could not. */
export type MaskReader = (
  c: HTMLCanvasElement,
  bounds: Box,
) => Promise<Mask | null>;

/** Every building's paint, mask and hover art, for one time of day. */
export class BuildingArt {
  private readonly baked = new Map<string, Baked>();
  private bakedPx = 0;
  private readonly masks = new Map<string, Mask>();
  private readonly hover = new Map<string, HoverArt>();
  private readonly probeR = MASK_DIL * MASK_C;
  private readonly probeC = canvas(this.probeR * 2 + 1, this.probeR * 2 + 1);
  private readonly probe = glowless(this.probeC, { willReadFrequently: true });
  private readonly animHaloC = canvas(1, 1);
  private readonly animHaloG = ctx2d(this.animHaloC);
  private readonly animPartC = canvas(1, 1);
  private readonly animPartG = glowless(this.animPartC);
  frame = 0;

  /**
   * `readMask`: where a painted building's hit mask is read ahead, off the
   * page (else it is read here, when first hit-tested); `onError`: a reader's
   * failure (a bug), for the engine to throw.
   */
  constructor(
    private readonly readMask: MaskReader | null = null,
    private readonly onError: (err: Error) => void = (err) => {
      throw err;
    },
  ) {}

  /** Painted buildings whose mask a worker is to read, in idle time. */
  private maskQueue: { key: string; c: HTMLCanvasElement; bounds: Box }[] = [];
  private draining = 0;
  private stopped = false;

  /**
   * Hands the next painted building to the mask reader when the page is idle:
   * handing it over copies the paint (a readback), which would otherwise land
   * in the frames that are busy baking. One a time; a building hit-tested
   * before its turn reads its mask itself.
   */
  private drainMasks(): void {
    if (this.draining || this.stopped || !this.maskQueue.length) return;
    const next = () => {
      this.draining = 0;
      const job = this.maskQueue.shift();
      if (!job || this.stopped) return;
      if (!this.masks.has(job.key) && this.readMask)
        void this.readMask(job.c, job.bounds).then(
          (m) => {
            if (m && !this.masks.has(job.key)) this.masks.set(job.key, m);
          },
          (err: unknown) =>
            this.onError(err instanceof Error ? err : new Error(String(err))),
        );
      this.drainMasks();
    };
    this.draining =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(next, { timeout: 4000 })
        : window.setTimeout(next, 100);
  }

  /** Stops handing masks over (this art is replaced or its engine gone). */
  stop(): void {
    this.stopped = true;
    this.maskQueue = [];
  }

  /** Every hit mask read so far, by building key. */
  maskEntries(): Iterable<[string, Mask]> {
    return this.masks.entries();
  }

  /** Whether the building's paint is baked (drawing it costs no paint). */
  isBaked(b: SceneBuilding): boolean {
    return this.baked.has(b.key);
  }

  /** The building's paint (baked on first use). */
  bake(b: SceneBuilding): HTMLCanvasElement {
    let e = this.baked.get(b.key);
    if (!e) {
      const [x0, y0, x1, y1] = b.bounds;
      const k = 2;
      const c = canvas((x1 - x0) * k, (y1 - y0) * k);
      const cg = ctx2d(c);
      cg.scale(k, k);
      cg.translate(-x0, -y0);
      b.spec.paint(cg, b.fresh());
      e = { c, px: c.width * c.height, used: this.frame };
      if (this.readMask && !this.masks.has(b.key)) {
        this.maskQueue.push({ key: b.key, c, bounds: b.bounds });
        this.drainMasks();
      }
      this.baked.set(b.key, e);
      this.bakedPx += e.px;
      if (this.bakedPx > BAKE_BUDGET) {
        const ents = [...this.baked.entries()].sort(
          (a, z) => a[1].used - z[1].used,
        );
        for (const [k2, v] of ents) {
          if (this.bakedPx < BAKE_KEEP) break;
          if (k2 === b.key) continue;
          this.baked.delete(k2);
          this.bakedPx -= v.px;
        }
      }
    }
    e.used = this.frame;
    return e.c;
  }

  draw(
    g: Ctx,
    b: SceneBuilding,
    x = b.x,
    y = b.y,
    solid = false,
    solidOf?: (c: HTMLCanvasElement) => HTMLCanvasElement,
  ): void {
    const c = this.bake(b);
    const [x0, y0, x1, y1] = b.bounds;
    g.drawImage(
      solid && solidOf ? solidOf(c) : c,
      x + x0,
      y + y0,
      x1 - x0,
      y1 - y0,
    );
  }

  private maskOf(b: SceneBuilding): Mask {
    let m = this.masks.get(b.key);
    if (m) return m;
    const c = this.bake(b);
    m = maskFromAlpha(
      ctx2d(c).getImageData(0, 0, c.width, c.height).data,
      c.width,
      c.height,
      b.bounds,
    );
    this.masks.set(b.key, m);
    return m;
  }

  /** Does a moving part cover (lx, ly) — building-local — right now? */
  private animHit(
    b: SceneBuilding,
    lx: number,
    ly: number,
    t: number,
  ): boolean {
    const animate = b.spec.animate;
    if (!animate) return false;
    const pr = this.probeR;
    const p = this.probe;
    b.state.t = t;
    p.setTransform(1, 0, 0, 1, 0, 0);
    p.clearRect(0, 0, this.probeC.width, this.probeC.height);
    p.setTransform(1, 0, 0, 1, pr + 0.5 - lx, pr + 0.5 - ly);
    p.save();
    animate(p, b.state);
    p.restore();
    const n = this.probeC.width;
    const d = p.getImageData(0, 0, n, n).data;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const dx = x - pr;
        const dy = y - pr;
        if (
          dx * dx + dy * dy <= pr * pr &&
          d[(y * n + x) * 4 + 3]! >= MASK_A_ANIM
        )
          return true;
      }
    return false;
  }

  /** Its drawn shape covers world point p. */
  shapeHit(b: SceneBuilding, px: number, py: number, t: number): boolean {
    const [x0, y0, x1, y1] = b.bounds;
    const lx = px - b.x;
    const ly = py - b.y;
    if (lx < x0 || lx >= x1 || ly < y0 || ly >= y1) return false;
    const m = this.maskOf(b);
    if (m.bits[(((ly - y0) / MASK_C) | 0) * m.gw + (((lx - x0) / MASK_C) | 0)])
      return true;
    return this.animHit(b, lx, ly, t);
  }

  private hoverArtOf(b: SceneBuilding): HoverArt {
    const hit = this.hover.get(b.key);
    if (hit) return hit;
    const m = this.maskOf(b);
    const c = this.bake(b);
    const [x0, y0, x1, y1] = b.bounds;
    const W = Math.ceil(x1 - x0);
    const H = Math.ceil(y1 - y0);
    // the silhouette, from the un-dilated mask, smoothed up to 1×
    const small = canvas(m.gw, m.gh);
    const sg = ctx2d(small);
    const id = sg.createImageData(m.gw, m.gh);
    for (let i = 0; i < m.raw.length; i++)
      if (m.raw[i]) id.data[i * 4 + 3] = 255;
    sg.putImageData(id, 0, 0);
    const sil = canvas(W, H);
    const lg = ctx2d(sil);
    lg.imageSmoothingEnabled = true;
    lg.drawImage(small, 0, 0, m.gw * MASK_C, m.gh * MASK_C);
    const tint = (src: HTMLCanvasElement, col: string) => {
      const t = canvas(src.width, src.height);
      const tg = ctx2d(t);
      tg.drawImage(src, 0, 0);
      tg.globalCompositeOperation = "source-in";
      tg.fillStyle = col;
      tg.fillRect(0, 0, t.width, t.height);
      return t;
    };
    const glowS = tint(sil, "#ffcf73");
    const rimS = tint(sil, "#fff4d2");
    const halo = canvas(W + HALO_P * 2, H + HALO_P * 2);
    const hg = ctx2d(halo);
    hg.filter = "blur(5px)";
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      hg.drawImage(glowS, HALO_P + Math.cos(a) * 4, HALO_P + Math.sin(a) * 4);
    }
    hg.filter = "none";
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      hg.drawImage(
        rimS,
        HALO_P + Math.cos(a) * 2.2,
        HALO_P + Math.sin(a) * 2.2,
      );
    }
    hg.globalCompositeOperation = "destination-out";
    hg.drawImage(sil, HALO_P, HALO_P);
    // the light on the building: its exact paint, minus the shadow, as a flat warm wash
    const lit = canvas(W, H);
    const tg = ctx2d(lit);
    tg.drawImage(c, 0, 0, W, H);
    tg.globalCompositeOperation = "destination-in";
    tg.drawImage(sil, 0, 0);
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = "#fff6dc";
    tg.fillRect(0, 0, W, H);
    const art = { halo, lit, sil, W, H };
    this.hover.set(b.key, art);
    return art;
  }

  /** Moving parts get their rim live (the hovered building only): animate() at ½ scale, ringed, inside cut out. */
  private animHalo(b: SceneBuilding, h: HoverArt, t: number) {
    const animate = b.spec.animate!;
    const [x0, y0] = b.bounds;
    const k = 0.5;
    const W = Math.ceil(h.W * k) + 8;
    const H = Math.ceil(h.H * k) + 8;
    const pc = this.animPartC;
    const pg = this.animPartG;
    if (pc.width !== W || pc.height !== H) {
      pc.width = this.animHaloC.width = W;
      pc.height = this.animHaloC.height = H;
    }
    pg.setTransform(1, 0, 0, 1, 0, 0);
    pg.clearRect(0, 0, W, H);
    pg.setTransform(k, 0, 0, k, 4 - x0 * k, 4 - y0 * k);
    b.state.t = t;
    pg.save();
    animate(pg, b.state);
    pg.restore();
    pg.setTransform(1, 0, 0, 1, 0, 0);
    const hg = this.animHaloG;
    hg.setTransform(1, 0, 0, 1, 0, 0);
    hg.globalCompositeOperation = "source-over";
    hg.clearRect(0, 0, W, H);
    pg.globalCompositeOperation = "source-in";
    pg.fillStyle = "#ffcf73";
    pg.fillRect(0, 0, W, H);
    pg.globalCompositeOperation = "source-over";
    hg.globalAlpha = 0.3;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      hg.drawImage(pc, Math.cos(a) * 3.5, Math.sin(a) * 3.5);
    }
    hg.globalAlpha = 0.55;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      hg.drawImage(pc, Math.cos(a) * 2, Math.sin(a) * 2);
    }
    pg.globalCompositeOperation = "source-in";
    pg.fillStyle = "#fff0c4";
    pg.fillRect(0, 0, W, H);
    pg.globalCompositeOperation = "source-over";
    hg.globalAlpha = 1;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      hg.drawImage(pc, Math.cos(a) * 1.1, Math.sin(a) * 1.1);
    }
    hg.globalCompositeOperation = "destination-out";
    hg.drawImage(pc, 0, 0);
    hg.drawImage(h.sil, 4, 4, h.W * k, h.H * k);
    hg.globalCompositeOperation = "source-over";
    return {
      c: this.animHaloC,
      x: x0 - 4 / k,
      y: y0 - 4 / k,
      w: W / k,
      h: H / k,
    };
  }

  /** The hover art at alpha a (glowOnly: the faint wash, at dusk and night). */
  drawHover(
    g: Ctx,
    b: SceneBuilding,
    a: number,
    glowOnly: boolean,
    t: number,
  ): void {
    const h = this.hoverArtOf(b);
    const [x0, y0] = b.bounds;
    g.globalAlpha = a;
    g.drawImage(h.halo, b.x + x0 - HALO_P, b.y + y0 - HALO_P);
    if (b.spec.animate) {
      const q = this.animHalo(b, h, t);
      g.drawImage(q.c, b.x + q.x, b.y + q.y, q.w, q.h);
    }
    g.globalAlpha = a * (glowOnly ? 0.06 : 0.13);
    g.drawImage(h.lit, b.x + x0, b.y + y0);
    g.globalAlpha = 1;
  }

  /** The hover art's size (for its layer). */
  hoverSize(b: SceneBuilding): { W: number; H: number } {
    const h = this.hoverArtOf(b);
    return { W: h.W, H: h.H };
  }
}
