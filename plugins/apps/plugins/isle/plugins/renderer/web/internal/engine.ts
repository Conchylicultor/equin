// The Isle engine: one canvas, the camera over it, and the frame loop that
// draws the world — tiles (a ground layer and an object layer each, baked
// centre-first within a frame's budget, another zoom's tile standing in
// meanwhile), the animated water between them, the people (each cut out by
// what stands in front of it), the hovered building's glow, the sky, the time
// of day's tint and lights, the signposts and the map labels. Input: drag with
// inertia, wheel and pinch zoom at the cursor, double-click zoom, click to
// open or walk (A*), arrows / WASD to walk, hold a building to move it.
// React only mounts it (`IsleCanvas`); everything here is imperative.

import {
  chimneySmoke,
  shade,
  type BuildingSpec,
  type PaintState,
} from "@plugins/apps/plugins/isle/plugins/buildings/core";
import type { LookName } from "@plugins/apps/plugins/isle/plugins/characters/core";
import {
  districtLabels,
  findPath,
  hash,
  islandLabels,
  layoutWorld,
  moveTargets,
  pickLabelSpot,
  plotBox,
  residentOf,
  RIVER,
  riverWidth,
  walkable,
  walkGrid,
  type DistrictLabel,
  type Island,
  type Layout,
  type MoveTarget,
  type Placement,
  type Resident,
  type WalkGrid,
  type WorldModel,
} from "@plugins/apps/plugins/isle/plugins/world/core";
import type { AppCategory } from "@plugins/primitives/plugins/pane/core";
import { BuildingArt, HALO_P, boundsOf, type SceneBuilding } from "./buildings";
import { FurnitureStore } from "./furniture";
import {
  GT,
  WAIT,
  bakeGroundTile,
  bakePreview,
  drawReeds,
  heightOver,
  oceanTexture,
  type BakeStep,
  type GroundTile,
  type Preview,
} from "./ground";
import { islandsNearTile } from "./ground-pixels";
import { leaseBakePool, type PoolLease } from "./bake-pool";
import {
  canvas,
  ctx2d,
  glowSprite,
  put,
  seeded,
  solidOf,
  ss,
  strHash,
  type Ctx,
  type Sprite,
} from "./kit";
import {
  drawSign,
  paintBridges,
  paintLot,
  paintRoads,
  paintSquare,
  SIGN_FONT,
} from "./paint";
import { LABELS_HIDDEN, stepLabels, type LabelState } from "./labels";
import { PBOX, People, type Hero, type Villager } from "./people";
import { realizeScene, TILE, type Scene, type Static } from "./scene";
import { DOCK_LEN, makeSprites, type SpriteSet } from "./sprites";

export type TimeOfDay = "day" | "dusk" | "night";

/** An app as the engine draws it. */
export interface IsleApp {
  readonly id: string;
  readonly name: string;
  readonly category: AppCategory;
  /** Its accent (`#rrggbb`, the tile colour). */
  readonly hue: string;
  readonly spec: BuildingSpec;
  /** Its icon glyph, white on transparent, square. */
  readonly glyph: CanvasImageSource;
}

/** What a click on a building asked for beyond opening it here. */
export interface ClickModifiers {
  readonly elsewhere: boolean;
  readonly keepOthers: boolean;
}

export interface EngineHooks {
  /** The home island is drawn: the title card's Start may go. */
  onReady(): void;
  /** The hero is (no longer) at a building's door. */
  onNear(appId: string | null): void;
  /**
   * Open an app (a click on its building): `at` is the screen point it opens
   * from; the click's modifiers: `elsewhere` (⌘/Ctrl — a new browser tab),
   * `keepOthers` (⌥).
   */
  onEnter(
    appId: string,
    at: { x: number; y: number },
    click: ClickModifiers,
  ): void;
  /** A building was dropped on a new spot (validated by the pure world). */
  onMove(appId: string, target: MoveTarget): void;
  /** Where the hero is: the island, and the district if any. */
  onWhere(island: string, district: string | null): void;
  /** The hero's foot came down (a footstep sound). */
  onStep(): void;
  /** The pointer is (no longer) over a building. */
  onHover(appId: string | null): void;
}

/**
 * How lived-in each app's building is, 0 (never opened: quiet) … 1 (opened
 * often and lately: smoke, lit windows, someone at the door) — or `null` while
 * that is not known yet, when the island shows none of it and claims nothing.
 * An app absent from a known map is 0.
 */
export type IsleLife = ReadonlyMap<string, number> | null;

export interface EngineOptions {
  readonly reducedMotion: boolean;
  /**
   * Bake in workers (ground colour, previews, hit masks) where the browser can
   * run them; `false` bakes everything on the page — the same pixels, the
   * page's frames paying for them.
   */
  readonly workers: boolean;
}

interface Tile {
  readonly c: HTMLCanvasElement;
  readonly o: HTMLCanvasElement | null;
  readonly lod: number;
  readonly tx: number;
  readonly ty: number;
  used: number;
  readonly px: number;
  /** Drawn from the baked ground (not a preview stand-in). */
  readonly final: boolean;
  stale: boolean;
}

interface Job<T> {
  readonly it: Generator<BakeStep, T, void>;
  /** Its pixels, when a worker colours them (it yields WAIT meanwhile). */
  readonly px: { readonly done: unknown } | null;
}

/** Ground jobs waiting on a worker, per worker: more would only queue work the view may not need. */
const JOBS_PER_WORKER = 2;

interface Moving {
  readonly b: SceneBuilding;
  readonly from: { x: number; y: number };
  sx: number;
  sy: number;
  readonly off: { x: number; y: number };
  readonly targets: readonly MoveTarget[];
  target: MoveTarget | null;
}

interface Settling {
  readonly b: SceneBuilding;
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly t0: number;
  /** The plot it is waiting to appear on (null: going back, nothing to wait for). */
  readonly awaiting: string | null;
}

interface HoverFx {
  b: SceneBuilding;
  a: number;
  layer: HTMLCanvasElement | null;
  L: {
    c: HTMLCanvasElement;
    W: number;
    H: number;
    x: number;
    y: number;
    k: number;
  } | null;
}

const LODS = [0.25, 0.5, 1, 2] as const;
const TILE_BUDGET = 64e6;
const GROUND_MAX = 120;
const Z_MAX = 2.6;
/** World px the hero walks between two footsteps. */
const STEP_PX = 30;
/** Seconds a building's life takes to fade in. */
const LIFE_FADE = 1.6;
/** How lived-in an app must be for a villager to linger at its door, and how many may. */
const LINGER_LIFE = 0.5;
const LINGERERS = 2;
const KEY_DIR: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
};
const VILLAGER_LOOKS: readonly LookName[] = [
  "villager1",
  "villager2",
  "villager3",
  "villager4",
  "villager5",
];
const easeIO = (p: number) => p * p * (3 - 2 * p);
const tileKey = (tx: number, ty: number) => `${tx}:${ty}`;

export class IsleEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: Ctx;
  private readonly fxc = canvas(1, 1);
  private readonly fg = ctx2d(this.fxc);
  private readonly personC = canvas(1, 1);
  private readonly sprites: SpriteSet = makeSprites();
  private readonly rnd = this.sprites.rnd;
  private readonly oceanPat: CanvasPattern;
  private readonly people = new People();
  private raf = 0;
  private disposed = false;

  // viewport and camera
  private dpr = 1;
  private vw = 0;
  private vh = 0;
  private readonly cam = { x: 0, y: 0, z: 1 };
  private zMin = 0.3;
  private camSet = false;

  // the world
  private M: WorldModel | null = null;
  private placement: Placement | null = null;
  private apps = new Map<string, IsleApp>();
  private residents: Resident[] = [];
  private furniture: FurnitureStore | null = null;
  private layout: Layout | null = null;
  private scene: Scene | null = null;
  private grid: WalkGrid | null = null;
  private buildings: SceneBuilding[] = [];
  private hidden = new Set<string>();
  private time: TimeOfDay = "day";
  private readonly lease: PoolLease | null;
  /** A worker's job failed (a bug, not an absence of workers): thrown by the next frame. */
  private failure: Error | null = null;
  private art: BuildingArt;
  /** The furniture the scene waits for, being laid out in the workers. */
  private furnitureWait: Promise<void> | null = null;
  private glyphTints = new Map<string, HTMLCanvasElement>();
  private districts: DistrictLabel[] = [];
  private readonly districtPick = new Map<string, number>();

  // tiles and bakes
  private readonly tileCache = new Map<string, Tile>();
  private tilePixels = 0;
  private frameNo = 0;
  private readonly ground = new Map<string, GroundTile & { used: number }>();
  private readonly gJobs = new Map<string, Job<GroundTile>>();
  private previewJobs: { I: Island; job: Job<Preview> }[] = [];
  private readonly previews = new Map<number, Preview>();
  private groundKeys: string[] = [];
  private groundKeySet = new Set<string>();
  private islandKey = "";
  private prevIslands: readonly Island[] = [];
  private readySent = false;

  // life
  private readonly hero: Hero = {
    look: "hero",
    x: 0,
    y: 0,
    facing: Math.PI / 2,
    walking: false,
    speed: 0,
    phase: 0,
    path: null,
    stepAt: 0,
    placed: false,
  };
  private readonly villagers: Villager[];
  private flies: { x: number; y: number; ph: number }[] = [];
  private glints: { x: number; y: number; ph: number }[] = [];
  private readonly riverS: {
    x: number;
    y: number;
    ux: number;
    uy: number;
    w: number;
  }[] = [];
  private readonly ripples: {
    u: number;
    o: number;
    len: number;
    v: number;
    ph: number;
  }[];
  private readonly clouds: {
    x: number;
    y: number;
    s: number;
    v: number;
    sp: Sprite;
  }[];
  private readonly gulls: {
    x: number;
    y: number;
    v: number;
    ph: number;
    r: number;
  }[];
  private marker: { x: number; y: number; t0: number } | null = null;
  private dust: { x: number; y: number; t0: number } | null = null;
  private nearDoor: SceneBuilding | null = null;
  private where = "";

  // input
  private started = false;
  private cameraStarted = false;
  private ptr: { x: number; y: number } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag: {
    id: number;
    sx: number;
    sy: number;
    lx: number;
    ly: number;
    moved: boolean;
    hist: [number, number, number][];
    touch: boolean;
  } | null = null;
  private pinch: { d0: number; z0: number; wx: number; wy: number } | null =
    null;
  private vel = { x: 0, y: 0 };
  private inertia = false;
  private zoomAnim: {
    target: number;
    sx: number;
    sy: number;
    wx: number;
    wy: number;
    k: number;
  } | null = null;
  private follow: { x: number; y: number } | null = null;
  private hold: { b: SceneBuilding; timer: number } | null = null;
  private moving: Moving | null = null;
  private settling: Settling | null = null;
  private hovered: SceneBuilding | null = null;
  private readonly hoverFx = new Map<string, HoverFx>();
  private readonly held = new Set<string>();
  private kbCam = false;
  private slideSide: 1 | -1 = 1;
  private labelState: LabelState = LABELS_HIDDEN;
  private life: IsleLife = null;
  /** Each app's life as drawn: eased toward `life`, so it fades in rather than pops. */
  private readonly lifeShown = new Map<string, number>();
  private hoverId: string | null = null;
  private last = performance.now();

  constructor(
    private readonly stage: HTMLElement,
    private readonly hooks: EngineHooks,
    private readonly opts: EngineOptions,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.touchAction = "none";
    this.canvas.style.cursor = "grab";
    stage.appendChild(this.canvas);
    this.g = ctx2d(this.canvas);
    this.lease = opts.workers ? leaseBakePool() : null;
    this.art = this.newArt();
    const pat = this.g.createPattern(oceanTexture(), "repeat");
    if (!pat) throw new Error("isle renderer: no ocean pattern");
    this.oceanPat = pat;
    const rnd = this.rnd;
    for (let i = 1; i < RIVER.length; i++) {
      const [ax, ay] = RIVER[i - 1]!;
      const [bx, by] = RIVER[i]!;
      const L = Math.hypot(bx - ax, by - ay);
      for (let s = 0; s < L; s += 10)
        this.riverS.push({
          x: ax + ((bx - ax) * s) / L,
          y: ay + ((by - ay) * s) / L,
          ux: (bx - ax) / L,
          uy: (by - ay) / L,
          w: riverWidth(i / (RIVER.length - 1)),
        });
    }
    this.ripples = Array.from({ length: 260 }, () => ({
      u: rnd(),
      o: (rnd() - 0.5) * 1.3,
      len: 6 + rnd() * 10,
      v: 0.008 + rnd() * 0.006,
      ph: rnd(),
    }));
    // (clouds and gulls are spread over the home island's old box, as the prototype placed them)
    const CX = 1600 * 1.6;
    const CY = 1230 * 1.6;
    this.clouds = Array.from({ length: 6 }, (_, i) => ({
      x: CX + (rnd() - 0.5) * 4000,
      y: CY + (rnd() - 0.5) * 3000,
      s: 0.8 + rnd() * 0.7,
      v: 7 + rnd() * 7,
      sp: this.sprites.clouds[i % 3]!,
    }));
    this.gulls = Array.from({ length: 6 }, () => ({
      x: rnd() * 3200,
      y: rnd() * 2400,
      v: 30 + rnd() * 20,
      ph: rnd() * 7,
      r: 60 + rnd() * 90,
    }));
    this.villagers = VILLAGER_LOOKS.map((look) => ({
      look,
      x: 0,
      y: 0,
      facing: Math.PI / 2,
      walking: false,
      speed: 0,
      phase: 0,
      route: null,
      routeKey: null,
      k: 0,
      dir: 1,
      wait: rnd() * 3,
      linger: null,
    }));
    this.cam.x = CX;
    this.cam.y = CY;
    this.bindInput();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.lease?.release();
    this.art.stop();
    if (this.hold) window.clearTimeout(this.hold.timer);
    this.unbind();
    this.canvas.remove();
    this.tileCache.clear();
    this.ground.clear();
  }

  // ---------------------------------------------------------------- public API

  /** The title card is gone: input and the walking camera begin. */
  start(): void {
    this.started = true;
  }

  /**
   * A fingerprint of everything baked so far — each ground tile's colour and
   * water mask, each island preview, each finished map tile's ground and
   * object layers (its scenery and buildings), each building's hit mask — keyed by what
   * it is: two engines on the same world that baked alike (in workers or on
   * the page) answer the same values for the keys both hold.
   */
  bakedDigest(): Record<string, string> {
    const out: Record<string, string> = {};
    const ofCanvas = (c: HTMLCanvasElement) =>
      bytesDigest(ctx2d(c).getImageData(0, 0, c.width, c.height).data);
    for (const [k, G] of this.ground) {
      out[`ground:${k}`] = ofCanvas(G.c);
      out[`water:${k}`] = ofCanvas(G.mask);
    }
    for (const [id, P] of this.previews) out[`preview:${id}`] = ofCanvas(P.c);
    for (const [k, T] of this.tileCache) {
      if (!T.final || T.stale) continue;
      out[`tile:${k}`] = ofCanvas(T.c);
      if (T.o) out[`objects:${k}`] = ofCanvas(T.o);
    }
    for (const [k, m] of this.art.maskEntries())
      out[`mask:${k}`] = `${m.gw}x${m.gh}:${bytesDigest(m.bits)}`;
    return out;
  }

  /** A worker's answer for a bake, as the bake's job reads it; `null` without workers. */
  private pixelJob<R>(
    ask: (pool: PoolLease["pool"]) => Promise<R | "failed">,
  ): { done: R | "failed" | null } | null {
    const pool = this.lease?.pool;
    if (!pool?.working) return null;
    const job: { done: R | "failed" | null } = { done: null };
    void ask(pool).then(
      (r) => {
        job.done = r;
      },
      (err: unknown) => {
        job.done = "failed";
        this.failure ??= err instanceof Error ? err : new Error(String(err));
      },
    );
    return job;
  }

  /** The building art for the current time of day, its hit masks read in a worker when there is one. */
  private newArt(): BuildingArt {
    const pool = this.lease?.pool ?? null;
    return new BuildingArt(
      pool
        ? (c, bounds) =>
            createImageBitmap(c)
              .then((bmp) => pool.mask(bmp, bounds))
              .then((m) => (m === "failed" ? null : m))
        : null,
      (err) => {
        this.failure ??= err;
      },
    );
  }

  /** Where a building's door is on screen (the iris opens there). */
  anchor(appId: string): { x: number; y: number } | null {
    const b = this.buildings.find((x) => x.appId === appId);
    return b ? this.toScreen(b.door[0], b.door[1] - 20) : null;
  }

  /** How lived-in each building is (`IsleLife`); `null` while not known. */
  setLife(life: IsleLife): void {
    this.life = life;
    if (this.layout) this.lingerersFollow();
  }

  /** A move's write did not land (stale): the building goes back. */
  cancelMove(): void {
    const s = this.settling;
    if (!s || s.awaiting === null) return;
    this.settling = null;
    this.hidden = new Set();
    this.realize();
  }

  setTime(time: TimeOfDay): void {
    if (time === this.time) return;
    this.time = time;
    // every painted building and every tile's object layer (lamps, buildings) is per time of day
    this.art.stop();
    this.art = this.newArt();
    this.hoverFx.clear();
    this.tileCache.clear();
    this.tilePixels = 0;
    for (const b of this.buildings) {
      b.state.night = time === "night";
      b.state.dusk = time === "dusk";
    }
  }

  /** The world to draw: the model (its seed), the stored placement and the apps placed on it. */
  setWorld(
    M: WorldModel,
    placement: Placement,
    apps: readonly IsleApp[],
  ): void {
    if (this.M !== M) {
      this.M = M;
      this.furniture = new FurnitureStore(M, this.sprites);
      this.tileCache.clear();
      this.tilePixels = 0;
      this.ground.clear();
      this.gJobs.clear();
      this.previewJobs = [];
      this.previews.clear();
      this.islandKey = "";
      this.prevIslands = [];
      this.scene = null;
      this.hero.placed = false;
      this.readySent = false;
      this.districtPick.clear();
    }
    this.placement = placement;
    this.apps = new Map(apps.map((a) => [a.id, a]));
    this.residents = apps.map((a) => residentOf(a, a.spec));
    const s = this.settling;
    if (s?.awaiting && placement.occupant[s.b.appId] === s.awaiting) {
      this.settling = null;
      this.hidden = new Set();
      this.dust = { x: s.to.x, y: s.to.y, t0: performance.now() / 1000 };
    }
    this.realize();
  }

  /** Moves each building's drawn life toward its known life (none while not known). */
  private easeLife(dt: number): void {
    const life = this.life;
    if (!life) return;
    const k = this.opts.reducedMotion ? 1 : dt / LIFE_FADE;
    for (const b of this.buildings) {
      const to = life.get(b.appId) ?? 0;
      const at = this.lifeShown.get(b.appId) ?? 0;
      const next = at < to ? Math.min(to, at + k) : Math.max(to, at - k);
      if (next !== at) this.lifeShown.set(b.appId, next);
    }
  }

  // ---------------------------------------------------------------- world → scene

  private paintState(
    app: IsleApp,
  ): PaintState & { t: number; open: boolean; night: boolean; dusk: boolean } {
    return {
      t: 0,
      night: this.time === "night",
      dusk: this.time === "dusk",
      open: false,
      hue: app.hue,
      shade,
      rnd: seeded(strHash(app.id)),
      glyph: (g, cx, cy, size) => {
        const fill = typeof g.fillStyle === "string" ? g.fillStyle : "#ffffff";
        g.drawImage(
          this.tintedGlyph(app, fill),
          cx - size / 2,
          cy - size / 2,
          size,
          size,
        );
      },
    };
  }

  private tintedGlyph(app: IsleApp, fill: string): HTMLCanvasElement {
    const key = `${app.id}|${fill}`;
    let c = this.glyphTints.get(key);
    if (c) return c;
    c = canvas(64, 64);
    const g = ctx2d(c);
    g.drawImage(app.glyph, 0, 0, 64, 64);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = fill;
    g.fillRect(0, 0, 64, 64);
    this.glyphTints.set(key, c);
    return c;
  }

  private realize(): void {
    const M = this.M;
    const placement = this.placement;
    const furniture = this.furniture;
    if (!M || !placement || !furniture) return;
    const shown = this.residents.filter((r) => !this.hidden.has(r.id));
    const layout = layoutWorld(M, placement, shown);
    // each island's furniture laid out in the workers first (the scene reads it)
    if (this.awaitFurniture(M, furniture, layout.islands)) return;
    const buildings: SceneBuilding[] = layout.buildings.map((pb) => {
      const app = this.apps.get(pb.appId)!;
      const spec = app.spec;
      const state = this.paintState(app);
      return {
        key: `b:${pb.appId}:${pb.plot.id}:${pb.signX}:${spec.footprint.w}`,
        appId: pb.appId,
        name: app.name,
        x: pb.x,
        y: pb.y,
        bounds: boundsOf(spec),
        spec,
        w: pb.w,
        depth: pb.depth,
        signX: pb.signX,
        signHalf: this.residents.find((r) => r.id === pb.appId)!.signHalf,
        door: pb.door,
        state,
        fresh: () => this.paintState(app),
      };
    });
    const scene = realizeScene(M, layout, buildings, furniture, this.sprites, {
      lamp: () =>
        this.time === "night"
          ? this.sprites.props.lamp.night
          : this.sprites.props.lamp.day,
      drawBuilding: (g, b, solid) =>
        this.art.draw(g, b, b.x, b.y, solid, solidOf),
    });
    // what changed → which tiles to throw away
    const prev = this.scene?.items ?? new Map();
    const dirty: (readonly number[])[] = [];
    scene.items.forEach((bb, k) => {
      if (!prev.has(k)) dirty.push(bb);
    });
    prev.forEach((bb, k) => {
      if (!scene.items.has(k)) dirty.push(bb);
    });
    this.invalidate(dirty);
    this.layout = layout;
    this.scene = scene;
    this.buildings = buildings;
    if (this.nearDoor)
      this.nearDoor =
        buildings.find((b) => b.appId === this.nearDoor!.appId) ?? null;
    const islandKey = layout.islands.map((I) => I.id).join(",");
    if (islandKey !== this.islandKey) {
      this.islandKey = islandKey;
      this.islandsChanged(M, layout);
    }
    this.grid = walkGrid(M, layout, scene.solids);
    this.districts = districtLabels(
      M,
      placement,
      layout,
      (id) => this.residents.find((r) => r.id === id)?.signHalf ?? 60,
    );
    this.villagersFollow();
    this.lingerersFollow();
    const [x0, y0, x1, y1] = layout.rect;
    this.zMin = Math.max(
      0.08,
      Math.min(this.vw / (x1 - x0), this.vh / (y1 - y0)),
    );
  }

  /**
   * Whether the scene must wait for the furniture of some of `islands`, being
   * laid out in the workers — `realize` runs again once it is in. Without
   * workers the scene lays it out itself (`FurnitureStore.of`).
   */
  private awaitFurniture(
    M: WorldModel,
    furniture: FurnitureStore,
    islands: readonly Island[],
  ): boolean {
    const pool = this.lease?.pool;
    const missing = islands.filter((I) => !furniture.has(I));
    if (!pool?.working || !missing.length) return false;
    if (this.furnitureWait) return true;
    this.furnitureWait = Promise.all(
      missing.map((I) =>
        pool.furniture(M, I).then((d) => {
          if (d !== "failed") furniture.adopt(I, d);
        }),
      ),
    ).then(
      () => {
        this.furnitureWait = null;
        if (!this.disposed && this.furniture === furniture) this.realize();
      },
      (err: unknown) => {
        this.furnitureWait = null;
        this.failure ??= err instanceof Error ? err : new Error(String(err));
      },
    );
    return true;
  }

  private islandsChanged(M: WorldModel, layout: Layout): void {
    const islands = layout.islands;
    for (const I of islands)
      if (
        !this.previews.has(I.id) &&
        !this.previewJobs.some((j) => j.I === I)
      ) {
        const remote = this.pixelJob((pool) => pool.preview(M, I));
        this.previewJobs.push({
          I,
          job: { it: bakePreview(M, I, remote), px: remote },
        });
      }
    const changed = [
      ...islands.filter((I) => !this.prevIslands.includes(I)),
      ...this.prevIslands.filter((I) => !islands.includes(I)),
    ];
    const touches = (I: Island, tx: number, ty: number) => {
      const [bx0, by0, bx1, by1] = I.bounds;
      return !(
        bx1 < tx * GT - 140 ||
        bx0 > (tx + 1) * GT + 140 ||
        by1 < ty * GT - 140 ||
        by0 > (ty + 1) * GT + 140
      );
    };
    for (const k of [...this.ground.keys(), ...this.gJobs.keys()]) {
      const [tx, ty] = k.split(":").map(Number) as [number, number];
      if (changed.some((I) => touches(I, tx, ty))) {
        this.ground.delete(k);
        this.gJobs.delete(k);
        this.dropLod(tx, ty);
      }
    }
    this.prevIslands = islands;
    // every tile an island reaches, except those all open sea
    const Hs = heightOver(M, islands);
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const I of islands) {
      const [bx0, by0, bx1, by1] = I.bounds;
      for (let ty = Math.floor(by0 / GT); ty <= Math.floor(by1 / GT); ty++)
        for (let tx = Math.floor(bx0 / GT); tx <= Math.floor(bx1 / GT); tx++) {
          const k = tileKey(tx, ty);
          if (seen.has(k)) continue;
          seen.add(k);
          let sea = true;
          for (let j = 0; j <= 8 && sea; j++)
            for (let i = 0; i <= 8 && sea; i++)
              if (Hs(tx * GT + (i * GT) / 8, ty * GT + (j * GT) / 8) > -0.5)
                sea = false;
          if (!sea) keys.push(k);
        }
    }
    this.groundKeys = keys;
    this.groundKeySet = new Set(keys);
    // glints on the open water
    const [x0, y0, x1, y1] = layout.rect;
    const n = Math.round((140 * ((x1 - x0) * (y1 - y0))) / (3624 * 2740));
    this.glints = [];
    for (let i = 0; i < n * 5 && this.glints.length < n; i++) {
      const x = x0 + hash(i, 1) * (x1 - x0);
      const y = y0 + hash(i, 2) * (y1 - y0);
      if (M.heightAt(x, y, islands) < -0.12) this.glints.push({ x, y, ph: i });
    }
  }

  /**
   * The most lived-in apps (at most {@link LINGERERS}, life ≥ {@link LINGER_LIFE})
   * each get a villager standing by their door; the rest walk the streets.
   */
  private lingerersFollow(): void {
    const life = this.life;
    const doors = life
      ? this.buildings
          .map((b) => ({ b, l: life.get(b.appId) ?? 0 }))
          .filter((x) => x.l >= LINGER_LIFE)
          .sort((a, b) => b.l - a.l || (a.b.appId < b.b.appId ? -1 : 1))
          .slice(0, LINGERERS)
          .map((x) => x.b)
      : [];
    const n = this.villagers.length;
    this.villagers.forEach((v, i) => {
      const b = doors[n - 1 - i];
      if (!b) {
        if (v.linger) {
          v.linger = null;
          v.route = null;
          v.routeKey = null;
        }
        return;
      }
      const side = strHash(b.appId) % 2 ? 1 : -1;
      const at = { x: b.door[0] + side * 30, y: b.door[1] + 18 };
      if (v.linger && v.linger.x === at.x && v.linger.y === at.y) return;
      v.linger = at;
      v.route = null;
      v.routeKey = null;
      v.x = at.x;
      v.y = at.y;
      v.walking = false;
      v.speed = 0;
      v.facing = side > 0 ? Math.PI : 0;
      v.wait = 0;
    });
    // a villager let go of its door goes back to the streets
    if (this.villagers.some((v) => !v.linger && !v.route))
      this.villagersFollow();
  }

  private villagersFollow(): void {
    const layout = this.layout!;
    const routes = layout.roads.filter(
      (r) => (r.kind === "trunk" || r.kind === "street") && r.pts.length > 6,
    );
    this.villagers.forEach((v, i) => {
      if (v.linger) return;
      if (v.route && layout.roads.some((r) => r.key === v.routeKey)) return;
      const r = routes[(i * 7 + routes.length) % Math.max(1, routes.length)];
      if (!r) {
        v.route = null;
        return;
      }
      v.route = r.pts;
      v.routeKey = r.key;
      v.k = (r.pts.length * ((i * 0.37) % 1)) | 0;
      v.x = r.pts[v.k]![0];
      v.y = r.pts[v.k]![1];
    });
    if (!this.hero.placed) {
      const q = layout.squares[0];
      const b = this.buildings[0];
      const at = q
        ? { x: q.x - 40, y: q.y + 60 }
        : b
          ? { x: b.door[0], y: b.door[1] + 30 }
          : null;
      if (at) {
        this.hero.x = at.x;
        this.hero.y = at.y;
        this.hero.placed = true;
        this.cam.x = at.x;
        this.cam.y = at.y;
      }
    }
    const trees = this.scene!.statics.filter((o) => o.tree);
    const rnd = this.rnd;
    this.flies = trees.length
      ? Array.from({ length: 180 }, () => {
          const t = trees[(rnd() * trees.length) | 0]!;
          return {
            x: (t.x0 + t.x1) / 2 + (rnd() - 0.5) * 90,
            y: t.y + (rnd() - 0.5) * 60,
            ph: rnd() * 7,
          };
        })
      : [];
  }

  // ---------------------------------------------------------------- tiles

  private invalidate(rects: readonly (readonly number[])[]): void {
    if (!rects.length) return;
    for (const [, e] of this.tileCache) {
      const x0 = e.tx * TILE;
      const y0 = e.ty * TILE;
      const x1 = x0 + TILE;
      const y1 = y0 + TILE;
      if (
        !e.stale &&
        rects.some(
          (r) => !(r[2]! < x0 || r[0]! > x1 || r[3]! < y0 || r[1]! > y1),
        )
      )
        e.stale = true;
    }
  }

  private dropLod(tx: number, ty: number): void {
    for (const l of LODS) {
      const e = this.tileCache.get(`${l}:${tx}:${ty}`);
      if (e) e.stale = true;
    }
  }

  private islandAt(tx: number, ty: number, homeOnly = false): boolean {
    const islands = this.layout?.islands ?? [];
    return islands.some((I) => {
      if (homeOnly && !I.home) return false;
      const [bx0, by0, bx1, by1] = I.bounds;
      return !(
        bx1 < tx * GT ||
        bx0 > (tx + 1) * GT ||
        by1 < ty * GT ||
        by0 > (ty + 1) * GT
      );
    });
  }

  /** Previews first, then the ground tiles in view nearest the centre, then nearby, within the budget. */
  private stepBakes(budgetMs: number, view: readonly number[]): void {
    const M = this.M;
    const furniture = this.furniture;
    const layout = this.layout;
    if (!M || !furniture || !layout) return;
    const t0 = performance.now();
    const left = () => performance.now() - t0 < budgetMs;
    for (let i = 0; i < this.previewJobs.length && left();) {
      const j = this.previewJobs[i]!;
      let r = j.job.it.next();
      while (!r.done && r.value !== WAIT && left()) r = j.job.it.next();
      if (r.done) {
        this.previews.set(j.I.id, r.value);
        this.previewJobs.splice(i, 1);
        for (const k of this.groundKeys) {
          if (this.ground.has(k)) continue;
          const [tx, ty] = k.split(":").map(Number) as [number, number];
          this.dropLod(tx, ty);
        }
      } else i++;
    }
    if (this.previewJobs.length || !left()) return this.readyCheck();
    // the buildings about the view painted ahead, nearest first, so a tile
    // reaching several never paints them all in one frame
    const near = this.buildings
      .filter(
        (b) =>
          !this.art.isBaked(b) &&
          b.x > view[0]! - GT &&
          b.x < view[2]! + GT &&
          b.y > view[1]! - GT &&
          b.y < view[3]! + GT,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - view[4]!, a.y - view[5]!) -
          Math.hypot(b.x - view[4]!, b.y - view[5]!),
      );
    for (const b of near) {
      if (!left()) return this.readyCheck();
      this.art.bake(b);
    }
    const cand: [number, string][] = [];
    for (const k of this.groundKeys) {
      if (this.ground.has(k)) continue;
      const [tx, ty] = k.split(":").map(Number) as [number, number];
      const cx = (tx + 0.5) * GT;
      const cy = (ty + 0.5) * GT;
      const inView =
        (tx + 1) * GT > view[0]! &&
        tx * GT < view[2]! &&
        (ty + 1) * GT > view[1]! &&
        ty * GT < view[3]!;
      const homeT = !this.readySent && this.islandAt(tx, ty, true);
      if (!inView && !homeT && this.ground.size >= GROUND_MAX) continue;
      cand.push([
        Math.hypot(cx - view[4]!, cy - view[5]!) +
          (inView ? 0 : 1e6) -
          (this.gJobs.has(k) ? 200 : 0) -
          (homeT ? 1e7 : 0),
        k,
      ]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const pool = this.lease?.pool;
    let remote = 0;
    for (const [, j] of this.gJobs) if (j.px && j.px.done === null) remote++;
    for (const [, best] of cand) {
      if (!left()) break;
      let j = this.gJobs.get(best);
      const [tx, ty] = best.split(":").map(Number) as [number, number];
      if (!j) {
        if (pool?.working && remote >= pool.size * JOBS_PER_WORKER) continue;
        const near = islandsNearTile(layout.islands, tx, ty);
        const px = this.pixelJob((p) => p.ground(M, tx, ty, near));
        if (px) remote++;
        j = {
          it: bakeGroundTile(M, tx, ty, near, furniture, px),
          px,
        };
        this.gJobs.set(best, j);
      }
      let r = j.it.next();
      while (!r.done && r.value !== WAIT && left()) r = j.it.next();
      if (r.done) {
        this.gJobs.delete(best);
        this.ground.set(best, { ...r.value, used: this.frameNo });
        this.dropLod(tx, ty);
        if (this.ground.size > GROUND_MAX) {
          // forget the ground farthest from view (it re-bakes if needed)
          let far: string | null = null;
          let fd = -1;
          for (const [k] of this.ground) {
            const [x2, y2] = k.split(":").map(Number) as [number, number];
            const dd =
              Math.hypot(
                (x2 + 0.5) * GT - view[4]!,
                (y2 + 0.5) * GT - view[5]!,
              ) - (!this.readySent && this.islandAt(x2, y2, true) ? 1e7 : 0);
            if (dd > fd) {
              fd = dd;
              far = k;
            }
          }
          if (far && far !== best) this.ground.delete(far);
        }
      }
    }
    this.readyCheck();
  }

  /** The title card waits for the home island's ground and the view the game opens on. */
  private readyCheck(): void {
    if (this.readySent || this.previewJobs.length || !this.layout) return;
    const home = this.layout.islands.find((I) => I.home);
    if (!home) return;
    const homeDone = this.groundKeys.every((k) => {
      if (this.ground.has(k)) return true;
      const [tx, ty] = k.split(":").map(Number) as [number, number];
      return !this.islandAt(tx, ty, true);
    });
    if (
      !homeDone ||
      !this.heroTiles().every(([tx, ty]) => this.tileFinal(tx, ty))
    )
      return;
    this.readySent = true;
    this.hooks.onReady();
  }

  private heroTiles(): [number, number][] {
    const hw = this.vw / 2 / this.cam.z + 80;
    const hh = this.vh / 2 / this.cam.z + 80;
    const cx = this.hero.x;
    const cy = this.hero.y - 40;
    const out: [number, number][] = [];
    for (
      let ty = Math.floor((cy - hh) / TILE);
      ty <= Math.floor((cy + hh) / TILE);
      ty++
    )
      for (
        let tx = Math.floor((cx - hw) / TILE);
        tx <= Math.floor((cx + hw) / TILE);
        tx++
      )
        out.push([tx, ty]);
    return out;
  }

  private tileFinal(tx: number, ty: number): boolean {
    const k = tileKey(tx, ty);
    const e = LODS.map((l) => this.tileCache.get(`${l}:${k}`)).find(
      (x) => x && !x.stale,
    );
    return (this.ground.has(k) || !this.groundKeySet.has(k)) && !!e && e.final;
  }

  /** → false when it had to use the coarse preview. */
  private paintGround(
    tg: Ctx,
    X0: number,
    Y0: number,
    X1: number,
    Y1: number,
  ): boolean {
    tg.fillStyle = this.oceanPat;
    tg.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
    const k = tileKey(Math.floor(X0 / GT), Math.floor(Y0 / GT));
    const G = this.ground.get(k);
    if (G) {
      G.used = this.frameNo;
      tg.drawImage(G.c, X0, Y0, GT, GT);
      return true;
    }
    tg.imageSmoothingQuality = "high";
    for (const I of this.layout?.islands ?? []) {
      const P = this.previews.get(I.id);
      const [bx0, by0, bx1, by1] = I.bounds;
      if (!P || bx0 > X1 || bx1 < X0 || by0 > Y1 || by1 < Y0) continue;
      const sx = Math.max(X0, P.x);
      const sy = Math.max(Y0, P.y);
      const ex = Math.min(X1, bx1);
      const ey = Math.min(Y1, by1);
      if (ex <= sx || ey <= sy) continue;
      tg.drawImage(
        P.c,
        (sx - P.x) * P.k,
        (sy - P.y) * P.k,
        (ex - sx) * P.k,
        (ey - sy) * P.k,
        sx,
        sy,
        ex - sx,
        ey - sy,
      );
    }
    return !this.islandAt(Math.floor(X0 / GT), Math.floor(Y0 / GT));
  }

  /** A tile: its ground (terrain, roads, squares, lots) and what stands on it (bridges, reeds, docks, scenery, buildings). */
  private buildTile(lod: number, tx: number, ty: number): Tile {
    const layout = this.layout!;
    const scene = this.scene!;
    const px = Math.round(TILE * lod);
    const c = canvas(px, px);
    const tg = ctx2d(c);
    tg.setTransform(lod, 0, 0, lod, -tx * TILE * lod, -ty * TILE * lod);
    let o: HTMLCanvasElement | null = canvas(px, px);
    const og = ctx2d(o);
    og.setTransform(lod, 0, 0, lod, -tx * TILE * lod, -ty * TILE * lod);
    const X0 = tx * TILE;
    const Y0 = ty * TILE;
    const X1 = X0 + TILE;
    const Y1 = Y0 + TILE;
    const final = this.paintGround(tg, X0, Y0, X1, Y1);
    paintRoads(tg, layout.roads, X0, Y0, X1, Y1);
    const G = this.ground.get(tileKey(tx, ty));
    const objs = scene.tileObjs.get(tileKey(tx, ty)) ?? [];
    let filled = !!(G && drawReeds(og, G.reeds, X0, Y0, X1, Y1)); // reeds first: a bridge crosses over them
    if (paintBridges(og, layout.roads, X0, Y0, X1, Y1)) filled = true;
    for (const q of layout.squares)
      if (
        q.x + q.r + 20 > X0 &&
        q.x - q.r - 20 < X1 &&
        q.y + q.r + 20 > Y0 &&
        q.y - q.r - 20 < Y1
      )
        paintSquare(tg, q);
    for (const p of layout.lots)
      if (
        Math.abs(p.x - (X0 + X1) / 2) < TILE / 2 + 160 &&
        Math.abs(p.y - (Y0 + Y1) / 2) < TILE / 2 + 120
      )
        paintLot(tg, p);
    for (const f of layout.ferries) {
      tg.strokeStyle = "rgba(240,236,220,.55)";
      tg.lineWidth = 2.2;
      tg.setLineDash([10, 12]);
      tg.beginPath();
      tg.moveTo(f.a[0], f.a[1]);
      tg.lineTo(f.b[0], f.b[1]);
      tg.stroke();
      tg.setLineDash([]);
    }
    this.art.frame = this.frameNo;
    for (const s of objs) s.draw(og);
    if (objs.length) filled = true;
    if (!filled) o = null; // nothing stands here: no object layer to keep or draw
    const key = `${lod}:${tx}:${ty}`;
    const old = this.tileCache.get(key);
    if (old) this.tilePixels -= old.px;
    const e: Tile = {
      c,
      o,
      lod,
      tx,
      ty,
      used: this.frameNo,
      px: px * px * (o ? 2 : 1),
      final,
      stale: false,
    };
    this.tileCache.set(key, e);
    this.tilePixels += e.px;
    if (this.tilePixels > TILE_BUDGET) {
      const ents = [...this.tileCache.entries()].sort(
        (a, b) => a[1].used - b[1].used,
      );
      for (const [k, v] of ents) {
        if (this.tilePixels <= TILE_BUDGET * 0.8 || v.used === this.frameNo)
          break;
        this.tileCache.delete(k);
        this.tilePixels -= v.px;
      }
    }
    return e;
  }

  // ---------------------------------------------------------------- viewport

  /** The stage's size, CSS px (its host measures it). */
  resize(width: number, height: number): void {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.vw = width;
    this.vh = height;
    this.canvas.width = Math.max(1, Math.round(this.vw * this.dpr));
    this.canvas.height = Math.max(1, Math.round(this.vh * this.dpr));
    this.fxc.width = this.canvas.width;
    this.fxc.height = this.canvas.height;
    this.canvas.style.width = `${this.vw}px`;
    this.canvas.style.height = `${this.vh}px`;
    if (!this.camSet && this.vw > 0) {
      this.camSet = true;
      this.cam.z = Math.max(
        0.6,
        Math.min(1.3, Math.min(this.vw, this.vh * 1.3) / 1100),
      );
    }
    if (this.layout) {
      const [x0, y0, x1, y1] = this.layout.rect;
      this.zMin = Math.max(
        0.08,
        Math.min(this.vw / (x1 - x0), this.vh / (y1 - y0)),
      );
    }
  }

  private toWorld(sx: number, sy: number) {
    return {
      x: (sx - this.vw / 2) / this.cam.z + this.cam.x,
      y: (sy - this.vh / 2) / this.cam.z + this.cam.y,
    };
  }
  private toScreen(x: number, y: number) {
    return {
      x: (x - this.cam.x) * this.cam.z + this.vw / 2,
      y: (y - this.cam.y) * this.cam.z + this.vh / 2,
    };
  }
  private clampZ(z: number) {
    return Math.max(this.zMin, Math.min(Z_MAX, z));
  }

  private signHit(b: SceneBuilding, p: { x: number; y: number }): boolean {
    const sx = b.x + b.signX;
    const sy = b.y + 12;
    const hw = b.signHalf - 4 + 3;
    return (
      (p.x > sx - hw && p.x < sx + hw && p.y > sy - 74 && p.y < sy - 34) ||
      (Math.abs(p.x - sx) < 7 && p.y > sy - 40 && p.y < sy + 3)
    );
  }

  /** The frontmost building under a world point: a signpost (drawn over everything) first, then a drawn shape. */
  private hitBuilding(
    p: { x: number; y: number },
    t: number,
  ): SceneBuilding | null {
    let best: SceneBuilding | null = null;
    if (this.cam.z > 0.38) {
      for (const b of this.buildings)
        if (this.signHit(b, p) && (!best || b.y > best.y)) best = b;
      if (best) return best;
    }
    for (const b of this.buildings) {
      if (best && b.y <= best.y) continue;
      if (this.art.shapeHit(b, p.x, p.y, t)) best = b;
    }
    return best;
  }

  private zoomAt(
    sx: number,
    sy: number,
    factor: number,
    animate: boolean,
  ): void {
    const target = this.clampZ(
      (this.zoomAnim ? this.zoomAnim.target : this.cam.z) * factor,
    );
    const w = this.toWorld(sx, sy);
    const anim = animate && !this.opts.reducedMotion;
    this.zoomAnim = { target, sx, sy, wx: w.x, wy: w.y, k: anim ? 0.07 : 0 };
    this.follow = null;
    this.kbCam = false;
    if (!anim) this.applyZoom(target);
  }

  private applyZoom(z: number): void {
    this.cam.z = z;
    const a = this.zoomAnim;
    if (a) {
      this.cam.x = a.wx - (a.sx - this.vw / 2) / z;
      this.cam.y = a.wy - (a.sy - this.vh / 2) / z;
    }
    if (a && z === a.target) this.zoomAnim = null;
  }

  private camBounds() {
    const [rx0, ry0, rx1, ry1] = this.layout?.rect ?? [0, 0, 1, 1];
    const hw = this.vw / 2 / this.cam.z;
    const hh = this.vh / 2 / this.cam.z;
    const mx = (rx0 + rx1) / 2;
    const my = (ry0 + ry1) / 2;
    return {
      x0: hw * 2 >= rx1 - rx0 ? mx : rx0 + hw,
      x1: hw * 2 >= rx1 - rx0 ? mx : rx1 - hw,
      y0: hh * 2 >= ry1 - ry0 ? my : ry0 + hh,
      y1: hh * 2 >= ry1 - ry0 ? my : ry1 - hh,
    };
  }

  // ---------------------------------------------------------------- input

  private readonly listeners: [
    EventTarget,
    string,
    EventListener,
    AddEventListenerOptions?,
  ][] = [];
  private on<E extends Event>(
    t: EventTarget,
    type: string,
    fn: (e: E) => void,
    o?: AddEventListenerOptions,
  ) {
    const f = fn as EventListener;
    t.addEventListener(type, f, o);
    this.listeners.push([t, type, f, o]);
  }
  private unbind(): void {
    for (const [t, type, f, o] of this.listeners)
      t.removeEventListener(type, f, o);
    this.listeners.length = 0;
  }

  private bindInput(): void {
    const c = this.canvas;
    this.on<WheelEvent>(
      c,
      "wheel",
      (e) => {
        e.preventDefault();
        if (!this.started) return;
        const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? this.vh : 1;
        const dy = e.deltaY * unit;
        const factor = Math.exp(-dy * (e.ctrlKey ? 0.012 : 0.0016));
        this.inertia = false;
        this.zoomAt(
          e.offsetX,
          e.offsetY,
          factor,
          !e.ctrlKey && Math.abs(dy) >= 40,
        );
      },
      { passive: false },
    );
    this.on<MouseEvent>(c, "dblclick", (e) => {
      if (this.started && !this.moving)
        this.zoomAt(e.offsetX, e.offsetY, 2, true);
    });
    this.on<PointerEvent>(c, "pointerdown", (e) => this.pointerDown(e));
    this.on<PointerEvent>(c, "pointermove", (e) => this.pointerMove(e));
    this.on<PointerEvent>(c, "pointerup", (e) => this.endPointer(e));
    this.on<PointerEvent>(c, "pointercancel", (e) => this.endPointer(e));
    this.on<PointerEvent>(c, "pointerleave", () => {
      this.ptr = null;
      if (!this.pointers.size) this.hovered = null;
    });
    // keys: the stage is focusable; walking keys are taken only while it has focus
    this.on<KeyboardEvent>(this.stage, "keydown", (e) => {
      if (e.key === "Escape" && this.moving) {
        e.stopPropagation();
        this.drop(false);
        return;
      }
      const d = KEY_DIR[e.code];
      if (
        !d ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        !this.started ||
        this.moving
      )
        return;
      e.preventDefault();
      if (e.repeat && this.held.has(e.code)) return;
      this.held.add(e.code);
      this.kbCam = true;
      this.follow = null;
      this.zoomAnim = null;
      this.inertia = false;
      this.hero.path = null;
      this.marker = null;
    });
    this.on<KeyboardEvent>(this.stage, "keyup", (e) =>
      this.held.delete(e.code),
    );
    this.on(this.stage, "focusout", () => this.held.clear());
    this.on(window, "blur", () => this.held.clear());
  }

  private cancelHold(): void {
    if (this.hold) {
      window.clearTimeout(this.hold.timer);
      this.hold = null;
    }
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.started || this.settling?.awaiting === null) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    this.inertia = false;
    this.follow = null;
    this.zoomAnim = null;
    this.kbCam = false;
    if (this.pointers.size === 1) {
      this.drag = {
        id: e.pointerId,
        sx: e.offsetX,
        sy: e.offsetY,
        lx: e.offsetX,
        ly: e.offsetY,
        moved: false,
        hist: [[performance.now(), e.offsetX, e.offsetY]],
        touch: e.pointerType === "touch",
      };
      const b =
        e.button === 0 && !this.settling
          ? this.hitBuilding(
              this.toWorld(e.offsetX, e.offsetY),
              performance.now() / 1000,
            )
          : null;
      if (b)
        this.hold = {
          b,
          // one-shot: holding still on a building lifts it
          timer: window.setTimeout(() => {
            if (this.hold && this.drag && !this.drag.moved)
              this.startMove(this.hold.b, this.drag.lx, this.drag.ly);
            this.hold = null;
          }, 260),
        };
    } else if (this.pointers.size === 2) {
      this.cancelHold();
      const [a, b] = [...this.pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const w = this.toWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinch = {
        d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        z0: this.cam.z,
        wx: w.x,
        wy: w.y,
      };
      if (this.drag) this.drag.moved = true;
    }
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (e.pointerType !== "touch") this.ptr = { x: e.offsetX, y: e.offsetY };
    if (!p) return;
    p.x = e.offsetX;
    p.y = e.offsetY;
    if (this.moving) {
      this.moving.sx = e.offsetX;
      this.moving.sy = e.offsetY;
      this.pickTarget();
      return;
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.cam.z = this.clampZ((this.pinch.z0 * d) / this.pinch.d0);
      this.cam.x = this.pinch.wx - ((a.x + b.x) / 2 - this.vw / 2) / this.cam.z;
      this.cam.y = this.pinch.wy - ((a.y + b.y) / 2 - this.vh / 2) / this.cam.z;
      return;
    }
    const drag = this.drag;
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.offsetX - drag.lx;
    const dy = e.offsetY - drag.ly;
    if (
      !drag.moved &&
      Math.hypot(e.offsetX - drag.sx, e.offsetY - drag.sy) >
        (drag.touch ? 10 : 5)
    ) {
      drag.moved = true;
      this.cancelHold();
      this.canvas.style.cursor = "grabbing";
    }
    if (drag.moved) {
      const b = this.camBounds();
      const rx = this.cam.x < b.x0 || this.cam.x > b.x1 ? 0.35 : 1;
      const ry = this.cam.y < b.y0 || this.cam.y > b.y1 ? 0.35 : 1;
      this.cam.x -= (dx / this.cam.z) * rx;
      this.cam.y -= (dy / this.cam.z) * ry;
    }
    drag.lx = e.offsetX;
    drag.ly = e.offsetY;
    const now = performance.now();
    drag.hist.push([now, e.offsetX, e.offsetY]);
    while (drag.hist.length > 2 && now - drag.hist[0]![0] > 90)
      drag.hist.shift();
  }

  private endPointer(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.cancelHold();
    if (this.moving) {
      this.drop(e.type === "pointerup");
      this.drag = null;
      return;
    }
    if (this.pinch) {
      if (this.pointers.size < 2) {
        this.pinch = null;
        const rest = [...this.pointers.entries()][0];
        this.drag = rest
          ? {
              id: rest[0],
              sx: rest[1].x,
              sy: rest[1].y,
              lx: rest[1].x,
              ly: rest[1].y,
              moved: true,
              hist: [],
              touch: true,
            }
          : null;
      }
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.canvas.style.cursor = this.hovered ? "pointer" : "grab";
    if (d.moved) {
      const h = d.hist;
      const now = performance.now();
      if (
        !this.opts.reducedMotion &&
        h.length >= 2 &&
        now - h[h.length - 1]![0] < 60
      ) {
        const [t0, x0, y0] = h[0]!;
        const [t1, x1, y1] = h[h.length - 1]!;
        const dt = Math.max(16, t1 - t0) / 1000;
        this.vel = {
          x: -(x1 - x0) / dt / this.cam.z,
          y: -(y1 - y0) / dt / this.cam.z,
        };
        this.inertia = Math.hypot(this.vel.x, this.vel.y) * this.cam.z > 60;
      }
      return;
    }
    if (e.type === "pointerup" && e.button === 0)
      this.click(e.offsetX, e.offsetY, {
        elsewhere: e.metaKey || e.ctrlKey,
        keepOthers: e.altKey,
      });
  }

  private click(sx: number, sy: number, mods: ClickModifiers): void {
    const p = this.toWorld(sx, sy);
    const b = this.hitBuilding(p, performance.now() / 1000);
    if (b) {
      this.hooks.onEnter(
        b.appId,
        this.toScreen(b.door[0], b.door[1] - 20),
        mods,
      );
      return;
    }
    this.walkTo(p.x, p.y);
  }

  private walkTo(x: number, y: number): void {
    if (!this.grid) return;
    const path = findPath(this.grid, this.hero.x, this.hero.y, x, y);
    if (!path) return;
    this.hero.path = path.slice(1);
    const end = path[path.length - 1]!;
    this.marker = { x: end[0], y: end[1], t0: performance.now() / 1000 };
  }

  private walkableAt(x: number, y: number): boolean {
    return this.grid !== null && walkable(this.grid, x, y);
  }

  private keyWalk(dt: number): boolean {
    let dx = 0;
    let dy = 0;
    for (const c of this.held) {
      const d = KEY_DIR[c];
      if (!d) continue;
      dx += d[0];
      dy += d[1];
    }
    const L = Math.hypot(dx, dy);
    if (!L) return false;
    const hero = this.hero;
    const sp = 120;
    const step = sp * dt;
    const ux = dx / L;
    const uy = dy / L;
    const from = this.walkableAt(hero.x, hero.y);
    // straight on; else turned up to ~75° toward whichever side is open (the side that worked last time first)
    let mx = 0;
    let my = 0;
    for (const a of [0, 0.35, 0.7, 1.05, 1.3]) {
      let ok = false;
      for (const sd of a
        ? ([this.slideSide, -this.slideSide] as const)
        : ([1] as const)) {
        const c = Math.cos(a * sd);
        const s2 = Math.sin(a * sd);
        const vx = ux * c - uy * s2;
        const vy = ux * s2 + uy * c;
        const k = step * Math.cos(a);
        const nx = hero.x + vx * k;
        const ny = hero.y + vy * k;
        if (!from || this.walkableAt(nx, ny)) {
          mx = nx - hero.x;
          my = ny - hero.y;
          if (a) this.slideSide = sd as 1 | -1;
          ok = true;
          break;
        }
      }
      if (ok) break;
    }
    hero.path = null;
    this.marker = null;
    hero.walking = true;
    hero.speed = sp;
    const turn = (to: number) => {
      let d = to - hero.facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      hero.facing += d * Math.min(1, dt * 14);
    };
    const m = Math.hypot(mx, my);
    if (m > 0.01) {
      hero.x += mx;
      hero.y += my;
      hero.phase += m;
      turn(Math.atan2(my, mx));
    } else {
      // pushing into a wall: turn to it, stand
      turn(Math.atan2(uy, ux));
      hero.walking = false;
      hero.speed = 0;
    }
    return true;
  }

  // ---- moving a building: lift it, show where it can go, drop it on a plot (swapping with whoever is there)

  private startMove(b: SceneBuilding, sx: number, sy: number): void {
    const M = this.M;
    const placement = this.placement;
    if (!M || !placement) return;
    this.drag = null;
    const w = this.toWorld(sx, sy);
    const targets = moveTargets(M, placement, this.residents, b.appId);
    this.moving = {
      b,
      from: { x: b.x, y: b.y },
      sx,
      sy,
      off: { x: b.x - w.x, y: b.y - w.y },
      targets,
      target: null,
    };
    this.hovered = null;
    this.hidden = new Set([b.appId]);
    this.realize();
    this.canvas.style.cursor = "grabbing";
    this.pickTarget();
  }

  private ghostAt() {
    const m = this.moving!;
    const w = this.toWorld(m.sx, m.sy);
    return { x: w.x + m.off.x, y: w.y + m.off.y };
  }

  private pickTarget(): void {
    const m = this.moving!;
    const gp = this.ghostAt();
    let best: MoveTarget | null = null;
    let bd = 180;
    for (const c of m.targets) {
      const d = Math.hypot(c.plot.x - gp.x, (c.plot.y - gp.y) * 1.2);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    m.target = best;
  }

  private drop(commit: boolean): void {
    const m = this.moving;
    if (!m) return;
    const gp = this.ghostAt();
    this.moving = null;
    this.canvas.style.cursor = "grab";
    const t = performance.now() / 1000;
    if (commit && m.target) {
      this.settling = {
        b: m.b,
        from: gp,
        to: { x: m.target.plot.x, y: m.target.plot.y },
        t0: t,
        awaiting: m.target.plot.id,
      };
      this.hooks.onMove(m.b.appId, m.target);
    } else
      this.settling = { b: m.b, from: gp, to: m.from, t0: t, awaiting: null };
  }

  // ---------------------------------------------------------------- the frame

  private frame(now: number): void {
    if (this.disposed) return;
    if (this.failure) throw this.failure;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    if (this.vw <= 0 || this.vh <= 0 || !this.layout || !this.scene) {
      this.last = now;
      return;
    }
    this.frameNo++;
    this.art.frame = this.frameNo;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.easeLife(dt);
    const t = now / 1000;
    this.last = now;
    const cam = this.cam;
    const { vw, vh, dpr } = this;
    const layout = this.layout;
    const scene = this.scene;
    const night = this.time === "night";
    const dusk = this.time === "dusk";
    // ground bakes run here, in slices, so the page never freezes
    {
      const hw0 = vw / 2 / cam.z;
      const hh0 = vh / 2 / cam.z;
      const viewMissing = this.groundKeys.some((k) => {
        if (this.ground.has(k)) return false;
        const [tx, ty] = k.split(":").map(Number) as [number, number];
        return (
          (tx + 1) * GT > cam.x - hw0 &&
          tx * GT < cam.x + hw0 &&
          (ty + 1) * GT > cam.y - hh0 &&
          ty * GT < cam.y + hh0
        );
      });
      const busy = this.drag || this.pinch || this.moving;
      this.stepBakes(
        !this.started
          ? 70
          : busy
            ? 4
            : (viewMissing || this.previewJobs.length) && cam.z > 0.55
              ? 28
              : 10,
        [cam.x - hw0, cam.y - hh0, cam.x + hw0, cam.y + hh0, cam.x, cam.y],
      );
    }
    this.walk(dt);
    this.moveCamera(dt, t);
    // hover: re-resolved under the resting mouse every frame, eased in and out (~150 ms)
    if (this.started) {
      const live =
        this.ptr &&
        !this.moving &&
        !this.settling &&
        !this.pinch &&
        !(this.drag && this.drag.moved);
      if (live && this.ptr) {
        this.hovered = this.hitBuilding(
          this.toWorld(this.ptr.x, this.ptr.y),
          t,
        );
        if (!this.drag) {
          const cur = this.hovered ? "pointer" : "grab";
          if (this.canvas.style.cursor !== cur) this.canvas.style.cursor = cur;
        }
      } else if (!this.ptr || this.moving || (this.drag && this.drag.moved))
        this.hovered = null;
      const hov = this.hovered;
      const hoverId = hov?.appId ?? null;
      if (hoverId !== this.hoverId) {
        this.hoverId = hoverId;
        this.hooks.onHover(hoverId);
      }
      if (hov && !this.hoverFx.has(hov.key))
        this.hoverFx.set(hov.key, { b: hov, a: 0, layer: null, L: null });
      for (const [k, f] of this.hoverFx) {
        const on = hov !== null && hov.key === k;
        if (on) f.b = hov;
        f.a = Math.max(0, Math.min(1, f.a + ((on ? 1 : -1) * dt) / 0.15));
        if (!on && f.a <= 0) this.hoverFx.delete(k);
      }
    }
    const hoverA = (b: SceneBuilding) => {
      const f = this.hoverFx.get(b.key);
      return f ? easeIO(f.a) : 0;
    };
    const z = cam.z;
    const hw = vw / 2 / z;
    const hh = vh / 2 / z;
    const x0 = cam.x - hw;
    const x1 = cam.x + hw;
    const y0 = cam.y - hh;
    const y1 = cam.y + hh;
    const g = this.g;
    const world2screen = () =>
      g.setTransform(
        dpr * z,
        0,
        0,
        dpr * z,
        dpr * (vw / 2 - cam.x * z),
        dpr * (vh / 2 - cam.y * z),
      );

    // --- the ground layer, from tiles
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#25608f";
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const need = z * dpr;
    const lod = LODS.find((l) => l >= need * 0.92) ?? LODS[LODS.length - 1]!;
    const tx0 = Math.floor(x0 / TILE);
    const tx1 = Math.floor(x1 / TILE);
    const ty0 = Math.floor(y0 / TILE);
    const ty1 = Math.floor(y1 / TILE);
    const budget = performance.now() + (this.started ? 7 : 14);
    type InView = {
      tx: number;
      ty: number;
      e: Tile | null;
      fb: Tile | null;
      sx: number;
      sy: number;
      w: number;
      h: number;
    };
    const inView: InView[] = [];
    // 1. what is in view, its cached tiles marked used first — so building one never evicts another the view shows
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const sx0 = Math.round(((tx * TILE - cam.x) * z + vw / 2) * dpr);
        const sy0 = Math.round(((ty * TILE - cam.y) * z + vh / 2) * dpr);
        const sx1 = Math.round((((tx + 1) * TILE - cam.x) * z + vw / 2) * dpr);
        const sy1 = Math.round((((ty + 1) * TILE - cam.y) * z + vh / 2) * dpr);
        const e = this.tileCache.get(`${lod}:${tx}:${ty}`) ?? null;
        let fb: Tile | null = null;
        if (!e || e.stale)
          for (const l of LODS) {
            const c = this.tileCache.get(`${l}:${tx}:${ty}`);
            if (c) {
              c.used = this.frameNo;
              if (!fb || Math.abs(l - lod) < Math.abs(fb.lod - lod)) fb = c;
            }
          }
        if (e) e.used = this.frameNo;
        inView.push({
          tx,
          ty,
          e,
          fb,
          sx: sx0,
          sy: sy0,
          w: sx1 - sx0,
          h: sy1 - sy0,
        });
      }
    // 2. the missing or stale ones built, nearest the centre first, within the frame's budget; at most 3 a frame
    //    while something (another zoom's tile, or the stale one) can stand in
    const ccx = cam.x / TILE - 0.5;
    const ccy = cam.y / TILE - 0.5;
    const todo = inView
      .filter((v) => !v.e || v.e.stale)
      .sort(
        (a, b) =>
          (a.tx - ccx) ** 2 +
          (a.ty - ccy) ** 2 -
          ((b.tx - ccx) ** 2 + (b.ty - ccy) ** 2),
      );
    let built = 0;
    for (const v of todo) {
      if (performance.now() >= budget) break;
      if (this.started && built >= 3 && (v.e || v.fb)) continue;
      v.e = this.buildTile(lod, v.tx, v.ty);
      built++;
    }
    // 3. drawn: the tile, else the nearest zoom's, else the bare ground
    for (const v of inView) {
      const e = v.e ?? v.fb;
      v.e = e;
      if (e) {
        e.used = this.frameNo;
        g.drawImage(e.c, v.sx, v.sy, v.w, v.h);
      } else {
        g.save();
        g.beginPath();
        g.rect(v.sx, v.sy, v.w, v.h);
        g.clip();
        world2screen();
        this.paintGround(
          g,
          v.tx * TILE,
          v.ty * TILE,
          (v.tx + 1) * TILE,
          (v.ty + 1) * TILE,
        );
        g.restore();
      }
    }
    // on the title card, also build the tiles of the view the game opens on, so Start shows a finished map
    if (!this.started)
      for (const [tx, ty] of this.heroTiles()) {
        const e = this.tileCache.get(`${lod}:${tx}:${ty}`);
        if ((!e || e.stale) && performance.now() < budget + 30)
          this.buildTile(lod, tx, ty);
      }
    const vis = (x: number, y: number, m = 80) =>
      x > x0 - m && x < x1 + m && y > y0 - m && y < y1 + m * 3;

    // --- water life: its own layer, kept to the water by each tile's mask, laid on the ground layer
    this.drawWater(t, z, x0, y0, x1, y1, inView);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.fxc, 0, 0);
    world2screen();
    // what floats: on the water, under whatever stands over it
    const dock = layout.dock;
    if (dock) {
      const da = Math.atan2(dock.ny, dock.nx);
      const [dx, dy] = dock.at;
      g.save();
      g.translate(
        dx + Math.cos(da) * (DOCK_LEN - 30) - Math.sin(da) * 64,
        dy + Math.sin(da) * (DOCK_LEN - 30) + Math.cos(da) * 64,
      );
      g.rotate(Math.sin(t * 1.1) * 0.03);
      put(g, this.sprites.boat, 0, Math.sin(t * 1.4) * 2.5);
      g.restore();
    }
    for (const f of layout.ferries) {
      const u = 0.5 - 0.5 * Math.cos((t * 0.05 + f.ph) * Math.PI * 2);
      const x = f.a[0] + (f.b[0] - f.a[0]) * u;
      const y = f.a[1] + (f.b[1] - f.a[1]) * u;
      if (!vis(x, y, 100)) continue;
      g.save();
      g.translate(x, y);
      if (f.b[0] < f.a[0] !== Math.sin((t * 0.05 + f.ph) * Math.PI * 2) < 0)
        g.scale(-1, 1);
      put(g, this.sprites.ferry, 0, Math.sin(t * 1.3) * 2);
      g.restore();
    }
    if (this.marker) {
      const mk = this.marker;
      const age = t - mk.t0;
      const pulse = 0.5 + 0.5 * Math.sin(age * 4);
      g.strokeStyle = `rgba(46,36,24,${0.35 + 0.2 * pulse})`;
      g.lineWidth = 1.4;
      g.beginPath();
      g.ellipse(mk.x, mk.y, 7 + pulse * 2, (7 + pulse * 2) * 0.45, 0, 0, 7);
      g.stroke();
      if (age < 0.5) {
        const k = age / 0.5;
        g.strokeStyle = `rgba(250,244,226,${0.8 * (1 - k)})`;
        g.lineWidth = 2;
        g.beginPath();
        g.ellipse(mk.x, mk.y, 8 + k * 18, (8 + k * 18) * 0.45, 0, 0, 7);
        g.stroke();
      }
    }

    // --- the object layer, from tiles
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const v of inView)
      if (v.e?.o) g.drawImage(v.e.o, v.sx, v.sy, v.w, v.h);
    world2screen();
    g.lineCap = "round";
    // where a lifted building may go
    if (this.moving) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 5);
      for (const c of this.moving.targets) {
        const p = c.plot;
        const on = c === this.moving.target;
        const B = plotBox(p);
        const swap = c.kind === "plot" && c.other !== null;
        g.save();
        g.setLineDash(on ? [] : [7, 6]);
        g.lineWidth = on ? 2.6 : 1.6;
        g.strokeStyle = on
          ? `rgba(255,246,220,${0.85 + 0.15 * pulse})`
          : swap
            ? "rgba(255,240,210,.45)"
            : "rgba(255,246,220,.75)";
        g.fillStyle = on
          ? "rgba(255,236,190,.22)"
          : c.kind === "new"
            ? "rgba(255,246,220,.07)"
            : "rgba(255,246,220,.1)";
        g.beginPath();
        g.roundRect(B[0] + 14, p.y - 90, B[2] - B[0] - 28, 110, 10);
        g.fill();
        g.stroke();
        g.restore();
      }
    }

    // --- the moving things, by depth; each person cut out by whatever stands in front
    const dyn: { y: number; d: () => void }[] = [];
    const tileObjsIn = (
      X0: number,
      Y0: number,
      X1: number,
      Y1: number,
      keep: (o: Static) => boolean,
    ) => {
      const seen = new Set<Static>();
      for (let ty = Math.floor(Y0 / TILE); ty <= Math.floor(Y1 / TILE); ty++)
        for (let tx = Math.floor(X0 / TILE); tx <= Math.floor(X1 / TILE); tx++)
          for (const o of scene.tileObjs.get(tileKey(tx, ty)) ?? []) {
            if (
              seen.has(o) ||
              o.x1 < X0 ||
              o.x0 > X1 ||
              o.y1 < Y0 ||
              o.y0 > Y1 ||
              !keep(o)
            )
              continue;
            seen.add(o);
          }
      return [...seen];
    };
    const frontOf = (b: SceneBuilding) => {
      const [bx0, by0, bx1, by1] = b.bounds;
      return tileObjsIn(
        b.x + bx0 - HALO_P,
        b.y + by0 - HALO_P,
        b.x + bx1 + HALO_P,
        b.y + by1 + HALO_P,
        (o) => o.y > b.y && o.building !== b,
      );
    };
    for (const [, f] of this.hoverFx) {
      f.L = null;
      const b = this.buildings.find((x) => x.key === f.b.key);
      if (!b || this.hidden.has(b.appId) || !vis(b.x, b.y, 300)) continue;
      const a = hoverA(b);
      if (a <= 0.01) continue;
      dyn.push({
        y: b.y,
        d: () => {
          f.L = this.hoverLayer(f, b, night || dusk, z, frontOf(b), t);
          this.putLayer(f.L, a);
        },
      });
    }
    for (const b of this.buildings) {
      const chimney = b.spec.chimney;
      const smoke = this.lifeShown.get(b.appId) ?? 0;
      if (!chimney || smoke <= 0.01 || !vis(b.x, b.y, 300)) continue;
      dyn.push({
        y: b.y,
        d: () => {
          g.save();
          g.translate(b.x, b.y);
          chimneySmoke(g, chimney, t, smoke);
          g.restore();
        },
      });
    }
    for (const b of this.buildings) {
      const animate = b.spec.animate;
      if (!vis(b.x, b.y, 300) || !animate) continue;
      dyn.push({
        y: b.y,
        d: () => {
          b.state.t = t;
          b.state.open = this.nearDoor === b;
          g.save();
          g.translate(b.x, b.y);
          animate(g, b.state);
          g.restore();
        },
      });
    }
    const village = layout.squares.find((q) => q.camp);
    if (village && vis(village.x, village.y)) {
      const fx = village.x;
      const fy = village.y;
      dyn.push({
        y: fy + 4,
        d: () => {
          for (let i = 0; i < 3; i++) {
            const fl = Math.sin(t * 9 + i * 2) * 2.5;
            g.fillStyle = [
              "rgba(220,110,40,.9)",
              "rgba(240,170,60,.9)",
              "rgba(255,230,150,.9)",
            ][i]!;
            g.beginPath();
            g.moveTo(fx - 10 + i * 3.5, fy);
            g.quadraticCurveTo(fx + fl, fy - 30 + i * 8, fx + 10 - i * 3.5, fy);
            g.fill();
          }
          for (let i = 0; i < 4; i++) {
            const k2 = (t * 0.3 + i / 4) % 1;
            g.fillStyle = `rgba(200,200,195,${0.25 * (1 - k2)})`;
            g.beginPath();
            g.arc(
              fx + Math.sin(k2 * 5 + i) * 6,
              fy - 34 - k2 * 60,
              4 + k2 * 10,
              0,
              7,
            );
            g.fill();
          }
        },
      });
    }
    const person = (p: Hero | Villager) => ({
      y: p.y,
      d: () => {
        const front = tileObjsIn(
          p.x + PBOX[0],
          p.y + PBOX[1],
          p.x + PBOX[2],
          p.y + PBOX[3],
          (o) => o.y > p.y,
        );
        if (!front.length) {
          this.people.draw(g, p, t);
          return;
        }
        // drawn into its own layer, cut out there by the solid part of whatever stands in front, then laid on the
        // scene — the tiles' pixels are never drawn a second time; the layer's pixels are the screen's
        const k = z * dpr;
        const ox = dpr * (vw / 2 - cam.x * z);
        const oy = dpr * (vh / 2 - cam.y * z);
        const sx = Math.floor((p.x + PBOX[0]) * k + ox);
        const sy = Math.floor((p.y + PBOX[1]) * k + oy);
        const W = Math.ceil((PBOX[2] - PBOX[0]) * k) + 2;
        const H = Math.ceil((PBOX[3] - PBOX[1]) * k) + 2;
        const pc = this.personC;
        if (pc.width < W || pc.height < H) {
          pc.width = Math.max(pc.width, W);
          pc.height = Math.max(pc.height, H);
        }
        const lg = ctx2d(pc);
        lg.setTransform(1, 0, 0, 1, 0, 0);
        lg.globalCompositeOperation = "source-over";
        lg.clearRect(0, 0, W, H);
        lg.setTransform(k, 0, 0, k, ox - sx, oy - sy);
        this.people.draw(lg, p, t);
        lg.globalCompositeOperation = "destination-out";
        for (const o of front) o.draw(lg, true);
        lg.globalCompositeOperation = "source-over";
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.drawImage(pc, 0, 0, W, H, sx, sy, W, H);
        world2screen();
      },
    });
    this.walkVillagers(dt);
    for (const v of this.villagers)
      if ((v.route || v.linger) && vis(v.x, v.y)) dyn.push(person(v));
    dyn.push(person(this.hero));
    // a building landing on its new plot (and waiting there for the write to come back)
    const st = this.settling;
    if (st) {
      const k = Math.min(1, (t - st.t0) / 0.32);
      const e = 1 - Math.pow(1 - k, 3);
      const x = st.from.x + (st.to.x - st.from.x) * e;
      const y = st.from.y + (st.to.y - st.from.y) * e;
      const lift = Math.sin(k * Math.PI) * 18 * (1 - k);
      dyn.push({ y, d: () => this.art.draw(g, st.b, x, y - lift) });
      if (k >= 1 && st.awaiting === null) {
        this.settling = null;
        this.hidden = new Set();
        this.realize();
        this.dust = { x: st.to.x, y: st.to.y, t0: t };
      }
    }
    dyn.sort((a, b) => a.y - b.y).forEach((o) => o.d());
    if (this.dust) {
      const k = (t - this.dust.t0) / 0.5;
      if (k > 1 || k < 0) this.dust = null;
      else {
        g.fillStyle = `rgba(214,200,160,${0.5 * (1 - k)})`;
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * 6.28;
          g.beginPath();
          g.ellipse(
            this.dust.x + Math.cos(a) * (30 + k * 60),
            this.dust.y + 6 + Math.sin(a) * (8 + k * 14),
            10 + k * 8,
            5 + k * 4,
            0,
            0,
            7,
          );
          g.fill();
        }
      }
    }
    // the lifted building, under the cursor
    if (this.moving) {
      const gp = this.ghostAt();
      g.fillStyle = "rgba(20,24,16,.25)";
      g.beginPath();
      g.ellipse(gp.x + 10, gp.y + 6, this.moving.b.w * 0.55, 16, 0, 0, 7);
      g.fill();
      g.globalAlpha = 0.92;
      this.art.draw(g, this.moving.b, gp.x, gp.y - 14);
      g.globalAlpha = 1;
    }

    // --- sky
    const rect = layout.rect;
    if (!night) {
      g.beginPath();
      for (const b of this.gulls) {
        b.x += b.v * dt;
        if (b.x > rect[2] + 200) b.x = rect[0] - 200;
        const y = b.y + Math.sin(t * 0.4 + b.ph) * b.r * 0.3;
        const w = Math.sin(t * 6 + b.ph) * 3.5;
        if (!vis(b.x, y)) continue;
        g.moveTo(b.x - 7, y - w);
        g.quadraticCurveTo(b.x - 3, y - 3, b.x, y);
        g.quadraticCurveTo(b.x + 3, y - 3, b.x + 7, y - w);
      }
      g.strokeStyle = "rgba(245,245,240,.9)";
      g.lineWidth = 1.8;
      g.stroke();
      g.strokeStyle = "rgba(40,40,45,.5)";
      g.lineWidth = 0.8;
      g.stroke();
    }
    for (const c of this.clouds) {
      c.x += c.v * dt;
      if (c.x > rect[2] + 400) c.x = rect[0] - 400;
    }
    g.fillStyle = "rgba(30,42,32,.09)";
    g.beginPath();
    for (const c of this.clouds) {
      g.moveTo(c.x + 120 + 120 * c.s, c.y + 170);
      g.ellipse(c.x + 120, c.y + 170, 120 * c.s, 40 * c.s, 0, 0, 7);
    }
    g.fill();
    if (!night) {
      g.globalAlpha = dusk ? 0.6 : 0.85;
      for (const c of this.clouds)
        if (vis(c.x, c.y, 300)) put(g, c.sp, c.x, c.y, c.s);
      g.globalAlpha = 1;
    }

    // --- time of day: tint, then lights through it
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (dusk || night) {
      g.globalCompositeOperation = "multiply";
      const tint = g.createLinearGradient(0, 0, 0, vh);
      if (dusk) {
        tint.addColorStop(0, "#f2c7a0");
        tint.addColorStop(1, "#d9a99c");
      } else {
        tint.addColorStop(0, "#26345e");
        tint.addColorStop(1, "#33466e");
      }
      g.fillStyle = tint;
      g.fillRect(0, 0, vw, vh);
      g.globalCompositeOperation = "lighter";
      const glow = (x: number, y: number, r: number, col: string) => {
        const s = this.toScreen(x, y);
        const R = r * z;
        if (s.x < -R || s.y < -R || s.x > vw + R || s.y > vh + R) return;
        g.drawImage(glowSprite(col), s.x - R, s.y - R, R * 2, R * 2);
      };
      const flick = 0.85 + Math.sin(t * 13) * 0.08 + Math.sin(t * 7.3) * 0.07;
      glow(
        this.hero.x,
        this.hero.y - 26,
        100,
        night ? "rgba(255,200,130,.32)" : "rgba(255,200,130,.12)",
      );
      if (village)
        glow(
          village.x,
          village.y - 14,
          220 * flick,
          night ? "rgba(255,140,50,.5)" : "rgba(255,150,60,.26)",
        );
      for (const [x, y, r] of scene.lights)
        glow(
          x,
          y,
          r,
          night ? "rgba(255,196,110,.38)" : "rgba(255,200,110,.15)",
        );
      if (this.hoverFx.size) {
        world2screen();
        for (const [, f] of this.hoverFx) {
          const b = this.buildings.find((x) => x.key === f.b.key);
          if (!b || this.hidden.has(b.appId) || !f.L) continue;
          const a = hoverA(b);
          if (a > 0.01) this.putLayer(f.L, a * (night ? 0.75 : 0.45));
        }
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      // windows: every one lit at night (the quiet ones dimmer, once usage is known); at dusk only the lived-in ones
      for (const b of this.buildings) {
        if (!vis(b.x, b.y, 300)) continue;
        const l = this.lifeShown.get(b.appId) ?? 0;
        const a = night ? (this.life ? 0.45 + 0.55 * l : 1) : 0.8 * l;
        if (a <= 0.01) continue;
        g.globalAlpha = a;
        const ls = b.spec.lights;
        if (ls.length)
          for (const [lx, ly, lr] of ls)
            glow(b.x + lx, b.y + ly, (lr || 30) * 2.2, "rgba(255,186,96,.36)");
        else glow(b.x, b.y - 36, 90, "rgba(255,186,96,.3)");
        g.globalAlpha = 1;
      }
      if (night) {
        if (this.nearDoor)
          glow(
            this.nearDoor.x,
            this.nearDoor.y - 10,
            110,
            "rgba(255,196,120,.4)",
          );
        if (z > 0.3) {
          for (const f of this.flies) {
            const a = Math.max(0, Math.sin(t * 1.6 + f.ph));
            if (a < 0.08) continue;
            g.globalAlpha = a;
            glow(
              f.x + Math.sin(t * 0.5 + f.ph) * 30,
              f.y + Math.cos(t * 0.4 + f.ph * 2) * 20,
              13,
              "rgba(255,226,120,.8)",
            );
          }
          g.globalAlpha = 1;
        }
      }
      g.globalCompositeOperation = "source-over";
    }
    // signs stay readable over everything, as on a map — and give way to district names when zoomed out
    const signA = ss(0.36, 0.6, z);
    if (signA > 0.01) {
      world2screen();
      g.globalAlpha = signA * (night ? 0.9 : 1);
      for (const b of this.buildings) {
        if (!vis(b.x + b.signX, b.y, 120)) continue;
        const app = this.apps.get(b.appId)!;
        drawSign(
          g,
          {
            x: b.x + b.signX,
            y: b.y + 12,
            name: b.name,
            signHalf: b.signHalf,
            tile: shade(app.hue, -0.12),
            glyph: this.tintedGlyph(app, "#ffffff"),
          },
          Math.max(hoverA(b), this.nearDoor === b ? 1 : 0),
        );
      }
      g.globalAlpha = 1;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawLabels(dt, z, night);
    const vg = g.createRadialGradient(
      vw / 2,
      vh / 2,
      Math.min(vw, vh) * 0.4,
      vw / 2,
      vh / 2,
      Math.max(vw, vh) * 0.78,
    );
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(28,24,16,.32)");
    g.fillStyle = vg;
    g.fillRect(0, 0, vw, vh);
  }

  private walk(dt: number): void {
    const hero = this.hero;
    const keyed = this.started && !this.moving && this.keyWalk(dt);
    if (!keyed && hero.walking && !hero.path) {
      hero.walking = false;
      hero.speed = 0;
    }
    if (!keyed && hero.path && hero.path.length) {
      const [tx, ty] = hero.path[0]!;
      const ex = tx - hero.x;
      const ey = ty - hero.y;
      const L = Math.hypot(ex, ey);
      const sp = 120;
      const step = sp * dt;
      if (L <= step) {
        hero.x = tx;
        hero.y = ty;
        hero.path.shift();
        hero.phase += L;
      } else {
        hero.x += (ex / L) * step;
        hero.y += (ey / L) * step;
        hero.phase += step;
      }
      if (L > 0.5) {
        let d = Math.atan2(ey, ex) - hero.facing;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        hero.facing += d * Math.min(1, dt * 14);
      }
      hero.walking = true;
      hero.speed = sp;
      if (!hero.path.length) {
        hero.path = null;
        hero.walking = false;
        hero.speed = 0;
        this.marker = null;
      }
    }
    if (hero.phase - hero.stepAt > STEP_PX) {
      hero.stepAt = hero.phase;
      this.hooks.onStep();
    }
    const nb =
      this.buildings.find(
        (b) => Math.hypot(hero.x - b.door[0], (hero.y - b.door[1]) * 1.4) < 46,
      ) ?? null;
    if (nb !== this.nearDoor) {
      const was = this.nearDoor?.appId ?? null;
      this.nearDoor = nb;
      if ((nb?.appId ?? null) !== was) this.hooks.onNear(nb?.appId ?? null);
    }
    this.reportWhere();
  }

  private reportWhere(): void {
    const layout = this.layout!;
    const hero = this.hero;
    let island: Island | null = null;
    let d0 = Infinity;
    for (const I of layout.islands) {
      const [bx0, by0, bx1, by1] = I.bounds;
      const d =
        Math.hypot(
          Math.max(bx0 - hero.x, 0, hero.x - bx1),
          Math.max(by0 - hero.y, 0, hero.y - by1),
        ) +
        Math.hypot(hero.x - I.cx, hero.y - I.cy) * 1e-3;
      if (d < d0) {
        d0 = d;
        island = I;
      }
    }
    let district: string | null = null;
    let dd = 700;
    for (const D of this.districts) {
      const d = Math.hypot(hero.x - D.x, hero.y - D.y);
      if (d < dd) {
        dd = d;
        district = D.name;
      }
    }
    const name = island?.name ?? "";
    const key = `${name}|${district ?? ""}`;
    if (key === this.where) return;
    this.where = key;
    this.hooks.onWhere(name, district);
  }

  private walkVillagers(dt: number): void {
    const rnd = this.rnd;
    for (const v of this.villagers) {
      if (v.linger) {
        // standing by the door: a glance to the street now and then, then back
        v.wait -= dt;
        if (v.wait <= 0) {
          const toDoor = v.linger.x > v.x ? 0 : Math.PI;
          const facingDoor =
            Math.abs(
              Math.atan2(
                Math.sin(v.facing - toDoor),
                Math.cos(v.facing - toDoor),
              ),
            ) < 0.5;
          v.facing = facingDoor ? Math.PI / 2 : this.lingerFacing(v);
          v.wait = facingDoor ? 1.5 + rnd() * 2 : 4 + rnd() * 6;
        }
        continue;
      }
      if (!v.route) continue;
      if (v.wait > 0) {
        v.wait -= dt;
        v.walking = false;
        v.speed = 0;
        continue;
      }
      const nk = v.k + v.dir;
      if (nk < 0 || nk >= v.route.length) {
        v.dir = v.dir === 1 ? -1 : 1;
        v.wait = 2 + rnd() * 5;
        continue;
      }
      const [gx, gy] = v.route[nk]!;
      const ex = gx - v.x;
      const ey = gy - v.y;
      const L = Math.hypot(ex, ey);
      const sp = 46;
      if (L < 3) {
        v.k = nk;
        if (rnd() < 0.01) v.wait = 1.5 + rnd() * 3;
      } else {
        v.walking = true;
        v.speed = sp;
        v.x += (ex / L) * sp * dt;
        v.y += (ey / L) * sp * dt;
        v.phase += sp * dt;
        let d = Math.atan2(ey, ex) - v.facing;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        v.facing += d * Math.min(1, dt * 8);
      }
    }
  }

  /** The way a lingering villager faces its door. */
  private lingerFacing(v: Villager): number {
    const b = this.buildings.find(
      (x) =>
        Math.abs(x.door[1] + 18 - v.y) < 1 && Math.abs(x.door[0] - v.x) < 40,
    );
    return b && b.door[0] < v.x ? Math.PI : 0;
  }

  private moveCamera(dt: number, t: number): void {
    const cam = this.cam;
    const { vw, vh } = this;
    const layout = this.layout!;
    if (!this.started) {
      // the title card's slow drift over the home square
      const home = layout.squares[0] ?? { x: this.hero.x, y: this.hero.y };
      if (this.opts.reducedMotion) {
        cam.x = home.x + 200;
        cam.y = home.y - 200;
      } else {
        cam.x = home.x + 200 + Math.cos(t * 0.05) * 420;
        cam.y = home.y - 200 + Math.sin(t * 0.07) * 260;
      }
      return;
    }
    if (!this.cameraStarted) {
      this.cameraStarted = true;
      this.follow = { x: this.hero.x, y: this.hero.y - 40 };
    }
    const za = this.zoomAnim;
    if (za && za.k) {
      const k = 1 - Math.exp(-dt / za.k);
      this.applyZoom(
        Math.abs(za.target - cam.z) / cam.z < 0.002
          ? za.target
          : cam.z + (za.target - cam.z) * k,
      );
    }
    if (this.inertia && !this.drag) {
      cam.x += this.vel.x * dt;
      cam.y += this.vel.y * dt;
      const fr = Math.exp(-dt * 4.2);
      this.vel.x *= fr;
      this.vel.y *= fr;
      if (Math.hypot(this.vel.x, this.vel.y) * cam.z < 12) this.inertia = false;
    }
    const m = this.moving;
    if (m) {
      const e = 46;
      const ex = m.sx < e ? m.sx - e : m.sx > vw - e ? m.sx - (vw - e) : 0;
      const ey = m.sy < e ? m.sy - e : m.sy > vh - e ? m.sy - (vh - e) : 0;
      if (ex || ey) {
        cam.x += (ex * 8 * dt) / cam.z;
        cam.y += (ey * 8 * dt) / cam.z;
        this.pickTarget();
      }
    }
    const hero = this.hero;
    // the keys bring the camera back to the hero (and in, if it is far out), then keep it there
    if (this.kbCam && !this.drag && !this.pinch && !m) {
      this.follow = { x: hero.x, y: hero.y - 40 };
      const zt = 0.75;
      if (cam.z < zt) cam.z += (zt - cam.z) * (1 - Math.exp(-dt * 2.5));
      if (
        !this.held.size &&
        Math.hypot(this.follow.x - cam.x, this.follow.y - cam.y) * cam.z < 0.5
      )
        this.kbCam = false;
    } else if (
      hero.walking &&
      !this.drag &&
      !this.pinch &&
      !this.inertia &&
      !m
    ) {
      const s = this.toScreen(hero.x, hero.y - 20);
      const mx = vw * 0.14;
      const my = vh * 0.16;
      const ox = s.x < mx ? s.x - mx : s.x > vw - mx ? s.x - (vw - mx) : 0;
      const oy = s.y < my ? s.y - my : s.y > vh - my ? s.y - (vh - my) : 0;
      if (ox || oy)
        this.follow = { x: cam.x + ox / cam.z, y: cam.y + oy / cam.z };
    }
    const f = this.follow;
    if (f && !this.drag && !this.pinch) {
      const k = this.opts.reducedMotion ? 1 : 1 - Math.exp(-dt * 3);
      cam.x += (f.x - cam.x) * k;
      cam.y += (f.y - cam.y) * k;
      if (Math.hypot(f.x - cam.x, f.y - cam.y) * cam.z < 0.5)
        this.follow = null;
    }
    if (!this.drag && !this.pinch) {
      if (cam.z < this.zMin)
        cam.z += (this.zMin - cam.z) * (1 - Math.exp(-dt * 8));
      const b = this.camBounds();
      const k = 1 - Math.exp(-dt * 10);
      const cx = Math.max(b.x0, Math.min(b.x1, cam.x));
      const cy = Math.max(b.y0, Math.min(b.y1, cam.y));
      if (cx !== cam.x) {
        cam.x += (cx - cam.x) * k;
        if (this.inertia) this.vel.x *= 0.5;
      }
      if (cy !== cam.y) {
        cam.y += (cy - cam.y) * k;
        if (this.inertia) this.vel.y *= 0.5;
      }
    }
  }

  private drawWater(
    t: number,
    z: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    inView: readonly {
      tx: number;
      ty: number;
      sx: number;
      sy: number;
      w: number;
      h: number;
    }[],
  ): void {
    const fg = this.fg;
    const { vw, vh, dpr, cam } = this;
    const layout = this.layout!;
    const M = this.M!;
    fg.setTransform(1, 0, 0, 1, 0, 0);
    fg.globalCompositeOperation = "source-over";
    fg.clearRect(0, 0, this.fxc.width, this.fxc.height);
    fg.setTransform(
      dpr * z,
      0,
      0,
      dpr * z,
      dpr * (vw / 2 - cam.x * z),
      dpr * (vh / 2 - cam.y * z),
    );
    fg.lineCap = "round";
    const every = z < 0.3 ? 4 : z < 0.45 ? 3 : z < 0.7 ? 2 : 1;
    const buckets: {
      f: { x: number; y: number; nx: number; ny: number; ph: number };
      w: number;
    }[][] = [[], [], [], []];
    for (const I of layout.islands) {
      const [bx0, by0, bx1, by1] = I.bounds;
      if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
      const co = this.furniture!.of(I).coast;
      for (let i = 0; i < co.length; i += every) {
        const f = co[i]!;
        if (f.x < x0 - 40 || f.x > x1 + 40 || f.y < y0 - 40 || f.y > y1 + 40)
          continue;
        const w = Math.sin(t * 0.9 + f.ph) * 0.5 + 0.5;
        buckets[Math.min(3, (w * 4) | 0)]!.push({ f, w });
      }
    }
    buckets.forEach((bk, bi) => {
      if (!bk.length) return;
      const wm = (bi + 0.5) / 4;
      fg.strokeStyle = `rgba(250,252,250,${0.25 + 0.45 * (1 - wm)})`;
      fg.lineWidth = 1.6 + (1 - wm) * 1.6;
      fg.beginPath();
      for (const { f, w } of bk) {
        const off = 3 + w * 12;
        const px = f.x + f.nx * off;
        const py = f.y + f.ny * off;
        const len = 5 + (f.ph % 1) * 5;
        fg.moveTo(px - f.ny * len, py + f.nx * len);
        fg.quadraticCurveTo(
          px + f.nx * 2,
          py + f.ny * 2,
          px + f.ny * len,
          py - f.nx * len,
        );
      }
      fg.stroke();
    });
    if (z > 0.35 && layout.islands.some((I) => I.home)) {
      const H = heightOver(M, layout.islands);
      fg.strokeStyle = "rgba(236,246,246,.4)";
      fg.lineWidth = 1.1;
      fg.beginPath();
      const rs = this.riverS;
      for (const r of this.ripples) {
        const u = (r.u + t * r.v) % 1;
        const s = rs[Math.min(rs.length - 1, (u * rs.length) | 0)]!;
        const o = r.o * s.w;
        const x = s.x - s.uy * o;
        const y = s.y + s.ux * o;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const life = Math.sin(((u * 37 + r.ph) % 1) * Math.PI);
        if (life < 0.25 || H(x, y) > -0.02) continue;
        const L = r.len * life;
        fg.moveTo(x - s.ux * L, y - s.uy * L);
        fg.quadraticCurveTo(
          x - s.uy * 1.5,
          y + s.ux * 1.5,
          x + s.ux * L,
          y + s.uy * L,
        );
      }
      fg.stroke();
    }
    fg.strokeStyle = "rgba(235,245,250,.3)";
    fg.lineWidth = 1.4;
    fg.beginPath();
    for (const s of this.glints) {
      if (
        s.x < x0 ||
        s.x > x1 ||
        s.y < y0 ||
        s.y > y1 ||
        Math.sin(t * 0.7 + s.ph) < 0.3
      )
        continue;
      fg.moveTo(s.x - 7, s.y);
      fg.lineTo(s.x + 7, s.y);
    }
    fg.stroke();
    fg.setTransform(1, 0, 0, 1, 0, 0);
    fg.globalCompositeOperation = "destination-in";
    for (const v of inView) {
      const k = tileKey(v.tx, v.ty);
      if (!this.groundKeySet.has(k)) continue; // open sea: water all over
      const G = this.ground.get(k);
      fg.save();
      fg.beginPath();
      fg.rect(v.sx, v.sy, v.w, v.h);
      fg.clip();
      if (G) fg.drawImage(G.mask, 1, 1, GT / 2, GT / 2, v.sx, v.sy, v.w, v.h);
      else fg.clearRect(v.sx, v.sy, v.w, v.h); // not baked yet: no mask, no water life
      fg.restore();
    }
    fg.globalCompositeOperation = "source-over";
  }

  /**
   * The hover art as it shows in the scene: drawn into its own layer, then cut out wherever something standing in
   * front of the building covers it — so nothing is drawn a second time over the scene.
   */
  private hoverLayer(
    f: HoverFx,
    b: SceneBuilding,
    glowOnly: boolean,
    z: number,
    front: readonly Static[],
    t: number,
  ) {
    const { W: hw, H: hh } = this.art.hoverSize(b);
    const [x0, y0] = b.bounds;
    const X0 = b.x + x0 - HALO_P;
    const Y0 = b.y + y0 - HALO_P;
    const k = Math.min(2, Math.max(0.25, z * this.dpr));
    const W = Math.ceil((hw + HALO_P * 2) * k);
    const H = Math.ceil((hh + HALO_P * 2) * k);
    const c = f.layer ?? (f.layer = canvas(W, H));
    if (c.width < W || c.height < H) {
      c.width = Math.max(c.width, W);
      c.height = Math.max(c.height, H);
    }
    const lg = ctx2d(c);
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.globalAlpha = 1;
    lg.globalCompositeOperation = "source-over";
    lg.clearRect(0, 0, W, H);
    lg.setTransform(k, 0, 0, k, -X0 * k, -Y0 * k);
    this.art.drawHover(lg, b, 1, glowOnly, t);
    if (front.length) {
      lg.globalCompositeOperation = "destination-out";
      for (const o of front) o.draw(lg);
      lg.globalCompositeOperation = "source-over";
    }
    return { c, W, H, x: X0, y: Y0, k };
  }

  private putLayer(
    L: {
      c: HTMLCanvasElement;
      W: number;
      H: number;
      x: number;
      y: number;
      k: number;
    },
    a: number,
  ): void {
    const g = this.g;
    g.globalAlpha = a;
    g.drawImage(L.c, 0, 0, L.W, L.H, L.x, L.y, L.W / L.k, L.H / L.k);
    g.globalAlpha = 1;
  }

  /**
   * Map labels, binary by zoom (× the zoom that fits the island under the view, with hysteresis), each group
   * fading in or out over LABEL_FADE seconds (`stepLabels`): district names around that zoom, island names from it outwards.
   */
  private drawLabels(dt: number, z: number, night: boolean): void {
    const g = this.g;
    const layout = this.layout!;
    const { vw, vh, cam } = this;
    let fitZ = 0.3;
    let fitD = Infinity;
    for (const I of layout.islands) {
      const [bx0, by0, bx1, by1] = I.bounds;
      const dx = Math.max(bx0 - cam.x, 0, cam.x - bx1);
      const dy = Math.max(by0 - cam.y, 0, cam.y - by1);
      const d = Math.hypot(dx, dy);
      if (d < fitD) {
        fitD = d;
        fitZ = Math.min(vw / (2 * I.rx), vh / (2 * I.ry));
      }
    }
    const L = (this.labelState = stepLabels(
      this.labelState,
      z / fitZ,
      this.opts.reducedMotion ? Infinity : dt,
    ));
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const distA = easeIO(L.dist.p);
    if (distA > 0.01) {
      const size = Math.round(15 + 4 * ss(0.42, 1, z));
      const hh = size * 0.62;
      g.font = `italic 500 ${size}px Fraunces, serif`;
      g.letterSpacing = "1.5px";
      g.textAlign = "center";
      g.textBaseline = "middle";
      const hitP = (x: number, y: number, w: number) =>
        placed.some(
          (q) => Math.abs(q.x - x) < q.w + w && Math.abs(q.y - y) < q.h + hh,
        );
      for (const D of this.districts) {
        const c = this.toScreen(D.x, D.y);
        const m = (D.r * 2 + 200) * z;
        if (c.x < -m || c.x > vw + m || c.y < -m || c.y > vh + m) continue;
        const tw = g.measureText(D.name).width;
        const w = tw / 2 + 22;
        const ww = w / z;
        const wh = (hh + 4) / z;
        const best = pickLabelSpot(
          D,
          this.districtPick.get(D.slot) ?? 0,
          ww,
          wh,
        );
        this.districtPick.set(D.slot, best);
        const order = [
          best,
          ...D.spots.map((_, i) => i).filter((i) => i !== best),
        ];
        const at = order
          .map((i) => this.toScreen(D.spots[i]![0], D.spots[i]![1]))
          .find((p) => !hitP(p.x, p.y, w));
        if (!at) continue;
        if (at.x < -w || at.x > vw + w || at.y < -hh || at.y > vh + hh)
          continue;
        placed.push({ x: at.x, y: at.y, w, h: hh });
        const ink = night ? "#f1e6cb" : "#3a2c1c";
        const halo = night ? "rgba(26,22,30,.7)" : "rgba(246,238,214,.78)";
        g.globalAlpha = distA;
        g.lineJoin = "round";
        g.strokeStyle = halo;
        g.lineWidth = 4;
        g.strokeText(D.name, at.x, at.y);
        g.fillStyle = ink;
        g.fillText(D.name, at.x, at.y);
        const fx = tw / 2 + 7;
        const FL = 12;
        g.globalAlpha = distA * 0.75;
        for (const sd of [-1, 1]) {
          const lx0 = at.x + sd * fx;
          const lx1 = lx0 + sd * FL;
          g.beginPath();
          g.moveTo(lx0, at.y + 1);
          g.quadraticCurveTo((lx0 + lx1) / 2, at.y - 2, lx1, at.y + 1);
          g.strokeStyle = halo;
          g.lineWidth = 3;
          g.stroke();
          g.strokeStyle = ink;
          g.lineWidth = 1;
          g.stroke();
          g.beginPath();
          g.arc(lx1 + sd * 2.5, at.y + 1, 1.3, 0, 7);
          g.fillStyle = ink;
          g.fill();
        }
      }
      g.globalAlpha = 1;
      g.letterSpacing = "0px";
    }
    const islandA = easeIO(L.isl.p);
    if (islandA > 0.01) {
      const size = 26;
      for (const lab of islandLabels(layout)) {
        const s = this.toScreen(lab.x, lab.y);
        if (s.x < -300 || s.x > vw + 300 || s.y < -60 || s.y > vh + 60)
          continue;
        const text = lab.name.toUpperCase();
        g.font = `600 ${size}px Fraunces, serif`;
        g.letterSpacing = "4px";
        const w = g.measureText(text).width / 2 + 6;
        const h = size * 0.7;
        const hit = (yy: number) =>
          placed.some(
            (q) =>
              Math.abs(q.x - s.x) < q.w + w && Math.abs(q.y - yy) < q.h + h,
          );
        const dy = [0, -1, 1, -2, 2]
          .map((k) => k * (h * 2 + 4))
          .find((d) => !hit(s.y + d));
        if (dy === undefined) continue;
        const y = s.y + dy;
        placed.push({ x: s.x, y, w, h });
        g.globalAlpha = islandA;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.lineJoin = "round";
        g.strokeStyle = "rgba(38,30,20,.72)";
        g.lineWidth = 5;
        g.strokeText(text, s.x, y);
        g.fillStyle = "#f4ead2";
        g.fillText(text, s.x, y);
      }
      g.globalAlpha = 1;
      g.letterSpacing = "0px";
    }
  }
}

/** The font specs the canvas draws text in: wait for them before the first frame. */
export const ISLE_FONTS = [
  SIGN_FONT,
  "italic 500 15px Fraunces",
  "600 26px Fraunces",
] as const;

/** FNV-1a over bytes, as hex: a fingerprint for comparing bakes. */
function bytesDigest(d: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
