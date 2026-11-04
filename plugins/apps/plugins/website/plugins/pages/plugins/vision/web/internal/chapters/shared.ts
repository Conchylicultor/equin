import {
  alongPath,
  polyline,
  random,
  smooth,
  travel,
  n1,
  type Pt,
} from "../kit/math";
import { C, OS_COL } from "../kit/palette";
import { setAttr, svgEl } from "../kit/svg";
import type { LiveFrame } from "./frame";
import { NODE, simpleApp, sphere } from "./orbit-kit";
import type { FlyingApp, Home, HomePlace } from "./os-orbit";

/**
 * Chapter 4 — shared: your orbit in the middle, everyone's own orbit drifting
 * around it, apps flowing freely from one to another. In frame 4 units; your
 * orbit is frame 3 beneath, at the centre, trading through {@link Home}.
 *
 * Leaving for chapter 5, every orbit here (yours too) becomes what a person is
 * there — a glowing node, three dots circling it — and flies out to a person
 * of the globe, merging into them ({@link World}).
 */

/** What chapters 4 and 5 share: the turning globe, as chapter 4's nodes join it. */
export interface World {
  /**
   * For each point (chapter 5 units), a person of the globe facing us, picked
   * out along the way the point sits from your corner (so they spread out), as
   * a function giving where they are now; the same people until `drop()`.
   */
  claim?(points: Pt[]): (null | (() => { x: number; y: number; a: number }))[];
  /** Forget them (chapter 4's orbits are orbits again). */
  drop?(): void;
}

const USERS = 6;
const TW = 34;
const TH = 24;
const EVERY = 1.25;
const DUR = 2.3;
const TRAIL = 0.9;
const LAT = 0.42;
const SLOTS = Array.from({ length: 8 }, (_, i) => ({
  lon: ((i >> 1) * Math.PI) / 2 + (i & 1) * (Math.PI / 4),
  lat: i & 1 ? -LAT : LAT,
}));
const proj = sphere({ R: 50, RX: 1.3, D: 160, TILT: 0.18 });

interface App extends FlyingApp {
  g: SVGGElement;
}
type SlotState = App | "res" | null;
interface User {
  a: number;
  aj: number;
  spread: number;
  spin: number;
  phase: number;
  g: SVGGElement;
  tiles: SVGGElement;
  slots: SlotState[];
  order: string;
  node?: Node5;
}
interface Node5 {
  g: SVGGElement;
  dots: SVGCircleElement[];
  spin: number;
  ph: number;
}
type Pos = { x: number; y: number; f: number; z: number };
interface Flow {
  src: number;
  dst: number;
  t0: number;
  ss: number | (FlyingApp & { pos(): Pos });
  ds: number | HomePlace;
  app: App | null;
  k1: number;
  trail: SVGPathElement;
}

/**
 * `r`: how many times bigger this frame is drawn while it is zoomed into (its
 * lines are thinned back by as much, so the orbits read as boldly at every step
 * of the zoom as your own does). `far`: how many times smaller this frame is in
 * chapter 5's. `to5` maps this frame's units to chapter 5's.
 */
export function mountShared(
  holder: SVGGElement,
  home: Home,
  r: number,
  far: number,
  world: World,
  to5: (c: Pt) => Pt,
  prefix: string,
): LiveFrame {
  const rnd = random(11);
  const COL = OS_COL;

  holder.appendChild(
    svgEl(
      "defs",
      {},
      `<radialGradient id="${prefix}zo4-glow"><stop offset="0" stop-color="${C.ice}" stop-opacity=".22"/><stop offset=".5" stop-color="${C.azure}" stop-opacity=".07"/><stop offset="1" stop-color="${C.azure}" stop-opacity="0"/></radialGradient>`,
    ),
  );
  const gUsers = svgEl("g");
  const gTrails = svgEl("g");
  const gFly = svgEl("g");
  const gNodes = svgEl("g", { opacity: "0" });
  holder.append(gUsers, gTrails, gFly, gNodes);
  const node = (cols: string[]): Node5 => {
    const g = svgEl("g");
    const dots = cols.map((c) =>
      svgEl("circle", { class: "zb-dot", r: n1(NODE.dot * far), fill: c }),
    );
    g.appendChild(
      svgEl("circle", {
        class: "zb-halo",
        r: n1(NODE.halo * far),
        fill: C.glow,
      }),
    );
    for (const d of dots) g.appendChild(d);
    gNodes.appendChild(g);
    return { g, dots, spin: 0.5 + rnd() * 0.7, ph: rnd() * 6.283 };
  };
  const ringsSvg = `<circle cx="0" cy="0" r="95" fill="url(#${prefix}zo4-glow)"/><path class="zo4-ring" d="${proj.ring(LAT)}"/><path class="zo4-ring" d="${proj.ring(-LAT)}"/>`;

  // an app: its look (colour, seed, size) and its drawing
  const app = (a: Partial<FlyingApp> = {}): App => {
    const k = 0.85 + rnd() * 0.35;
    const col = a.col || COL[Math.floor(rnd() * COL.length)]!;
    const seed = a.seed || Math.floor(rnd() * 1e9);
    const W = a.W || n1(TW * k * (0.85 + rnd() * 0.35));
    const H = a.H || n1(TH * k);
    return { col, seed, W, H, g: svgEl("g", {}, simpleApp(col, W, H, seed)) };
  };
  const users: User[] = [];
  for (let u = 0; u < USERS; u++) {
    const g = svgEl("g");
    const tiles = svgEl("g");
    g.appendChild(svgEl("g", {}, ringsSvg));
    g.appendChild(tiles);
    gUsers.appendChild(g);
    const U: User = {
      a: ((-60 + u * 60) * Math.PI) / 180,
      aj: (rnd() - 0.5) * 0.7,
      spread: 0.45 + rnd() * 0.75,
      spin: (2 * Math.PI) / (44 + 9 * u),
      phase: u * 1.7,
      g,
      tiles,
      slots: SLOTS.map(() => null),
      order: "",
    };
    for (let k = 0; k < 5; k++) {
      let sl = Math.floor(rnd() * SLOTS.length);
      while (U.slots[sl]) sl = (sl + 1) % SLOTS.length;
      const a = app();
      tiles.appendChild(a.g);
      U.slots[sl] = a;
    }
    users.push(U);
  }
  for (const U of users)
    U.node = node(
      U.slots
        .filter((x): x is App => !!x && x !== "res")
        .slice(0, 3)
        .map((a) => a.col),
    );
  const youNode = node(COL.slice(0, 3));
  let q5 = 0;
  let mg = 0;

  let t = 0;
  let nextFlow = 0.6;
  let flows: Flow[] = [];
  // where an orbit is: everyone's drift slowly around yours, each with a little sway of its own
  // (as they become nodes they move apart, to the spacing people have on chapter 5's globe — each to
  // its own distance and a little off its angle, so they don't stand in a ring; and they drift more)
  function centre(ui: number): Pt {
    const U = users[ui]!;
    const a = U.a + (t * 2 * Math.PI) / 160 + q5 * U.aj;
    const sp = 1 + q5 * U.spread;
    const sw = 1 + 2.5 * q5;
    return [
      Math.cos(a) * 340 * sp + Math.sin(t * 0.31 + ui * 1.3) * 18 * sw,
      Math.sin(a) * 285 * sp + Math.cos(t * 0.27 + ui * 2.1) * 14 * sw,
    ];
  }
  // where an app sits: a slot of someone's orbit, or a place of yours (whose pos() follows your orbit)
  function at(ui: number, slot: Flow["ss"] | Flow["ds"]): Pos {
    if (typeof slot !== "number") return slot.pos();
    const c = centre(ui);
    const q = proj(
      SLOTS[slot]!.lon,
      SLOTS[slot]!.lat,
      t * users[ui]!.spin + users[ui]!.phase,
    );
    return { x: c[0] + q.x, y: c[1] + q.y, f: q.f, z: q.z };
  }
  const count = (U: User) => U.slots.filter(Boolean).length;

  function launch() {
    // from whom, to whom: yours is in some of the moves, when it can give or take one
    let src: number;
    let dst: number;
    let tries = 0;
    const srcOk = (i: number) => i < 0 || count(users[i]!) >= 4;
    const dstOk = (i: number) => i < 0 || count(users[i]!) < 7;
    do {
      src = rnd() < 0.18 ? -1 : Math.floor(rnd() * USERS);
      dst = src >= 0 && rnd() < 0.2 ? -1 : Math.floor(rnd() * USERS);
    } while ((src === dst || !srcOk(src) || !dstOk(dst)) && ++tries < 20);
    if (tries >= 20) return;
    let ds: Flow["ds"] | null = null;
    if (dst < 0) {
      ds = home.adopt();
      if (!ds) return;
    }
    let ss: Flow["ss"];
    let a: App;
    if (src >= 0) {
      const full: number[] = [];
      users[src]!.slots.forEach((x, j) => {
        if (x && x !== "res") full.push(j);
      });
      ss = full[Math.floor(rnd() * full.length)]!;
      a = users[src]!.slots[ss] as App;
      users[src]!.slots[ss] = null;
    } else {
      const rel = home.release();
      if (!rel) {
        if (ds && typeof ds !== "number") ds.cancel();
        return;
      }
      ss = rel;
      a = app({ col: rel.col, seed: rel.seed, W: rel.W, H: rel.H });
    }
    gFly.appendChild(a.g);
    if (dst >= 0) {
      const free: number[] = [];
      users[dst]!.slots.forEach((x, j) => {
        if (!x) free.push(j);
      });
      ds = free[Math.floor(rnd() * free.length)]!;
      users[dst]!.slots[ds] = "res";
    }
    const dsv = ds!;
    // an app flying to you takes the shape of the place it will fill there
    const k1 = typeof dsv !== "number" ? dsv.W / a.W : 1;
    const trail = svgEl("path", {
      class: "zo4-trail",
      stroke: a.col,
      pathLength: "1",
      "stroke-dasharray": "1 1",
    });
    gTrails.appendChild(trail);
    flows.push({ src, dst, t0: t, ss, ds: dsv, app: a, k1, trail });
  }

  function render() {
    // leaving for chapter 5: the orbits fade into their nodes
    for (const g of [gUsers, gTrails, gFly])
      setAttr(g, "opacity", (1 - q5).toFixed(3));
    setAttr(gNodes, "opacity", q5.toFixed(3));
    if (q5 <= 0.001) world.drop?.();
    const all = [youNode, ...users.map((U) => U.node!)];
    // each node flies out to someone on the globe (spread the way it sits) and merges into them
    const claimed =
      q5 > 0.001 && world.claim
        ? world.claim(all.map((_, i) => to5(i ? centre(i - 1) : [0, 0])))
        : null;
    if (q5 > 0.001)
      all.forEach((N, i) => {
        let c: Pt = i ? centre(i - 1) : [0, 0];
        const claim = claimed?.[i];
        if (claim) {
          const T = claim();
          const p5 = to5(c);
          const m = travel(mg);
          const o = to5([0, 0]);
          c = [
            (p5[0] + (T.x - p5[0]) * m - o[0]) * far,
            (p5[1] + (T.y - p5[1]) * m - o[1]) * far,
          ];
          setAttr(
            N.g,
            "opacity",
            ((1 - smooth((mg - 0.75) / 0.25)) * (1 + (T.a - 1) * m)).toFixed(3),
          );
        }
        setAttr(
          N.g,
          "transform",
          `translate(${n1(c[0])} ${n1(c[1])}) scale(${(1 + 0.05 * Math.sin(t * 0.9 + N.ph)).toFixed(3)})`,
        );
        N.dots.forEach((d, j) => {
          const an = N.ph + t * N.spin + j * 2.094;
          setAttr(d, "cx", String(n1(Math.cos(an) * NODE.orbit * far)));
          setAttr(d, "cy", String(n1(Math.sin(an) * NODE.orbit * 0.83 * far)));
        });
      });
    flows = flows.filter((F) => {
      const age = t - F.t0;
      const m = travel(age / DUR);
      const A = at(F.src, F.ss);
      const B = at(F.dst, F.ds);
      const mx = (A.x + B.x) / 2;
      const my = (A.y + B.y) / 2;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const cx = mx - dy * 0.22;
      const cy = my + dx * 0.22;
      const pts: Pt[] = [];
      for (let k = 0; k <= 24; k++) {
        const u = k / 24;
        pts.push([
          (1 - u) * (1 - u) * A.x + 2 * (1 - u) * u * cx + u * u * B.x,
          (1 - u) * (1 - u) * A.y + 2 * (1 - u) * u * cy + u * u * B.y,
        ]);
      }
      const head = alongPath(pts, m);
      const f = A.f + (B.f * F.k1 - A.f) * m;
      if (age < DUR) {
        setAttr(
          F.app!.g,
          "transform",
          `translate(${n1(head[0])} ${n1(head[1])}) scale(${(f * (1 + 0.25 * Math.sin(Math.PI * m))).toFixed(3)})`,
        );
      } else if (F.app) {
        // it lands: in someone's orbit, or in yours, where your orbit draws it from now on
        if (typeof F.ds === "number") {
          const U = users[F.dst]!;
          U.slots[F.ds] = F.app;
          U.tiles.appendChild(F.app.g);
          U.order = "";
        } else {
          home.land(F.ds, F.app);
          gFly.removeChild(F.app.g);
        }
        F.app = null;
      }
      setAttr(F.trail, "d", polyline(pts));
      setAttr(F.trail, "stroke-dashoffset", (1 - m).toFixed(3));
      setAttr(
        F.trail,
        "opacity",
        (0.45 * (1 - smooth((age - DUR) / TRAIL))).toFixed(3),
      );
      if (age > DUR + TRAIL) {
        gTrails.removeChild(F.trail);
        return false;
      }
      return true;
    });
    // the orbits after the moves, so a tile that just landed is placed in its orbit this very frame
    users.forEach((U, ui) => {
      const c = centre(ui);
      setAttr(U.g, "transform", `translate(${n1(c[0])} ${n1(c[1])})`);
      const list: { z: number; x: App; j: number }[] = [];
      U.slots.forEach((x, j) => {
        if (!x || x === "res") return;
        const q = at(ui, j);
        setAttr(
          x.g,
          "transform",
          `translate(${n1(q.x - c[0])} ${n1(q.y - c[1])}) scale(${q.f.toFixed(3)})`,
        );
        list.push({ z: q.z, x, j });
      });
      list.sort((A, B) => A.z - B.z);
      const sig = list.map((l) => l.j).join(",");
      if (sig !== U.order) {
        U.order = sig;
        for (const l of list) U.tiles.appendChild(l.x.g);
      }
    });
  }

  render();
  return {
    update(p) {
      holder.style.setProperty(
        "--zo4-k",
        Math.pow(r, Math.min(0, p - 4)).toFixed(3),
      );
      q5 = NODE.fade(p);
      mg = Math.max(0, Math.min(1, (p - 4.3) / 0.6));
      render();
    },
    tick(dt) {
      t += dt;
      while (t >= nextFlow) {
        launch();
        nextFlow += EVERY;
      }
      render();
    },
  };
}
