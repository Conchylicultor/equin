import { alongPath, random, smooth, travel, type Pt } from "../kit/math";
import { C, OS_COL, type Colour } from "../kit/palette";
import type { Surface } from "../kit/surface";
import type { LiveFrame } from "./frame";
import { NODE } from "./orbit-kit";
import type { World } from "./shared";

/**
 * Chapter 5 — every app: the earth by night, slowly turning. People are glowing
 * nodes, each with three dots circling it (the orbits of chapter 4, too far
 * away to see their apps). Arcs keep lifting off the surface between
 * neighbours, each carrying a packet of light; whoever receives one flares.
 * Lights and people rise over the globe's edge and set behind it as it turns.
 * In frame 5 units: `front` holds the people and arcs; `under` (on the back
 * layer, beneath frame 4) the globe's grid and lights.
 *
 * Every mark moves every frame, so both layers are canvases ({@link Surface}),
 * repainted whole — not ~200 SVG nodes re-posed (each write a style recalc).
 */

const GR = 470;
const TURN = 110;
const TILT5 = 0.38;
const ARC_EVERY = 0.3;
const ARC_DUR = 2.4;
const PEOPLE = 44;
/** Lights: two sizes (diameters), and six brightness steps — one fill per size and step. */
const SIZES = [2.6, 4.6];
const LEVELS = 6;
/** The grid's dashes, and its line and the arcs' widths (thinned by the zoom's k), in frame units. */
const GRID_DASH = [3, 6];
const GRID_W = 1;
const ARC_W = 1.3;
/** A person's halo at rest, and a packet's. */
const HALO = 0.14;
const PACKET_HALO = 0.35;

type V3 = [number, number, number];
interface Person {
  v: V3;
  dots: string[];
  spin: number;
  ph: number;
  flare: number;
}
interface Arc {
  A: Person;
  B: Person;
  t0: number;
  col: string;
}

/**
 * `you.at`: your corner (frame 4's centre, where the zoom comes from), whose
 * nodes fly out to people of the globe (`world.claim`). `r`: how many times
 * bigger this frame is drawn while it is zoomed into (its lines thinned back by
 * as much).
 */
export function mountGlobe(
  front: Surface,
  under: Surface,
  you: { at: Pt },
  r: number,
  world: World,
): LiveFrame {
  const rnd = random(23);
  const hue = (c: Colour) => front.colour(c);
  const HUE = OS_COL;
  const ring = under.colour(C.ring);
  const glow = under.colour(C.glow);
  const frost = front.colour(C.frost);
  const ct = Math.cos(TILT5);
  const st = Math.sin(TILT5);
  // a point of the globe (unit vector, turned by rot) → screen; z > 0 faces us
  const unit = (lon: number, lat: number): V3 => [
    Math.cos(lat) * Math.sin(lon),
    -Math.sin(lat),
    Math.cos(lat) * Math.cos(lon),
  ];
  const place = (v: V3, rot: number, lift = 1) => {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const x = v[0] * c + v[2] * s;
    const z = v[2] * c - v[0] * s;
    const y = v[1];
    const y2 = y * ct + z * st;
    const z2 = z * ct - y * st;
    const R = GR * lift;
    return { x: x * R, y: y2 * R, z: z2 };
  };
  // how much a point faces us (fades out towards the edge)
  const seen = (q: { z: number }) => smooth((q.z - 0.02) / 0.3);

  // the grid: meridians and parallels, traced on the side facing us
  const gridLine = (
    g: CanvasRenderingContext2D,
    fn: (u: number) => V3,
    rot: number,
  ) => {
    let on = false;
    for (let k = 0; k <= 128; k++) {
      const q = place(fn(k / 128), rot);
      if (q.z > 0) {
        if (on) g.lineTo(q.x, q.y);
        else g.moveTo(q.x, q.y);
        on = true;
      } else on = false;
    }
  };
  // the lights: towns around a few hubs
  const hubs: Pt[] = [];
  for (let i = 0; i < 16; i++) hubs.push([rnd() * 6.283, (rnd() - 0.5) * 2.2]);
  // (most in towns around the hubs, the rest scattered: the globe has no dark half)
  const lights: {
    v: V3;
    size: number;
    base: number;
    tw: number;
    ph: number;
  }[] = [];
  for (let i = 0; i < 480; i++) {
    const hb: Pt =
      i % 5 === 4
        ? [rnd() * 6.283, Math.asin(rnd() * 2 - 1) * 0.9]
        : hubs[i % hubs.length]!;
    const a = rnd() * 6.283;
    const rd = i % 5 === 4 ? 0 : Math.pow(rnd(), 1.5) * 0.4;
    lights.push({
      v: unit(hb[0] + Math.cos(a) * rd, hb[1] + Math.sin(a) * rd * 0.7),
      size: rnd() < 0.7 ? 0 : 1,
      base: 0.35 + rnd() * 0.6,
      tw: rnd() < 0.3 ? 1.5 + rnd() * 2.5 : 0,
      ph: rnd() * 6.283,
    });
  }
  // a light's (size, brightness) bucket, reused every paint
  const buckets: Pt[][] = SIZES.flatMap(() =>
    Array.from({ length: LEVELS }, () => [] as Pt[]),
  );
  // the people
  const people: Person[] = [];
  for (let i = 0; i < PEOPLE; i++) {
    // spread evenly over the globe (a Fibonacci sphere), a little off the grid
    const fz = 1 - (2 * (i + 0.5)) / PEOPLE;
    const hub: Pt = [i * 2.39996 + (rnd() - 0.5) * 0.3, Math.asin(fz) * 0.92];
    const dots: string[] = [];
    for (let j = 0; j < 3; j++)
      dots.push(hue(HUE[Math.floor(rnd() * HUE.length)]!));
    const spin = (0.5 + rnd() * 0.7) * (rnd() < 0.5 ? -1 : 1);
    people.push({
      v: unit(hub[0], hub[1]),
      dots,
      spin,
      ph: rnd() * 6.283,
      flare: -9,
    });
  }

  let t = 0;
  let k = 1;
  let nextArc = 0;
  let arcs: Arc[] = [];
  let claims: ReturnType<NonNullable<World["claim"]>> | null = null;
  world.claim = (pts) => {
    if (claims) return claims;
    const rot = (t * 2 * Math.PI) / TURN;
    const taken = new Set<number>();
    claims = pts.map((p, i) => {
      // aim past the point, outward from your corner (the centre node aims at the corner itself)
      const aim = i
        ? [
            you.at[0] + (p[0] - you.at[0]) * 3.2,
            you.at[1] + (p[1] - you.at[1]) * 3.2,
          ]
        : you.at;
      let best = -1;
      let bd = 1e9;
      people.forEach((P, j) => {
        const q = place(P.v, rot);
        if (taken.has(j) || seen(q) < 0.7) return;
        const dd = Math.hypot(q.x - aim[0]!, q.y - aim[1]!);
        if (dd < bd) {
          bd = dd;
          best = j;
        }
      });
      if (best < 0) return null;
      taken.add(best);
      const who = people[best]!;
      return () => {
        const q = place(who.v, (t * 2 * Math.PI) / TURN);
        return { x: q.x, y: q.y, a: seen(q) };
      };
    });
    return claims;
  };
  world.drop = () => {
    claims = null;
  };
  const dist = (p: Person, q: Person) =>
    Math.acos(
      Math.max(
        -1,
        Math.min(1, p.v[0] * q.v[0] + p.v[1] * q.v[1] + p.v[2] * q.v[2]),
      ),
    );
  function launch(rot: number) {
    // between two people facing us, neighbours
    const vis = people.filter((P) => seen(place(P.v, rot)) > 0.6);
    if (vis.length < 2) return;
    // to someone not too far: one of the nearest few (so most arcs stay on the side facing us)
    const B = vis[Math.floor(rnd() * vis.length)]!;
    const near = vis
      .filter((P) => P !== B)
      .sort((p, q) => dist(p, B) - dist(q, B))
      .slice(0, 4);
    const A = near[Math.floor(rnd() * near.length)];
    if (!A) return;
    const col = hue(HUE[Math.floor(rnd() * HUE.length)]!);
    arcs.push({ A, B, t0: t, col });
  }
  // the arc's points now: over the surface, lifted midway
  function arcPts(F: Arc, rot: number): Pt[] {
    const pts: Pt[] = [];
    const N = 24;
    const b = F.B.v;
    const a = F.A.v;
    const dot = Math.max(
      -1,
      Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]),
    );
    const om = Math.acos(dot);
    const so = Math.sin(om) || 1e-6;
    for (let k = 0; k <= N; k++) {
      const s2 = k / N;
      const wa = Math.sin((1 - s2) * om) / so;
      const wb = Math.sin(s2 * om) / so;
      const v: V3 = [
        a[0] * wa + b[0] * wb,
        a[1] * wa + b[1] * wb,
        a[2] * wa + b[2] * wb,
      ];
      const q = place(v, rot, 1 + 0.22 * om * Math.sin(Math.PI * s2));
      pts.push([q.x, q.y]);
    }
    return pts;
  }
  // the first m (0…1) of a polyline's length, as a path (an arc drawn out from its tail)
  function tracePart(g: CanvasRenderingContext2D, pts: Pt[], m: number) {
    let len = 0;
    for (let i = 1; i < pts.length; i++)
      len += Math.hypot(
        pts[i]![0] - pts[i - 1]![0],
        pts[i]![1] - pts[i - 1]![1],
      );
    let left = m * len;
    if (left <= 0) return;
    g.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d >= left) {
        const f = d ? left / d : 0;
        g.lineTo(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
        return;
      }
      g.lineTo(b[0], b[1]);
      left -= d;
    }
  }

  // the globe's grid and lights, beneath frame 4
  function drawUnder(rot: number) {
    const g = under.begin();
    if (!g) return;
    // grid: each meridian is a whole great circle (lon and lon + 180°), so the 6 cover the globe every 30°
    g.strokeStyle = ring;
    g.lineWidth = GRID_W * k;
    g.setLineDash(GRID_DASH);
    // one stroke per line, as each was its own SVG path: where two cross they add up
    const line = (fn: (u: number) => V3) => {
      g.beginPath();
      gridLine(g, fn, rot);
      g.stroke();
    };
    g.globalAlpha = 0.7;
    for (let m = 0; m < 6; m++) {
      const lon = (m * Math.PI) / 6;
      line((u) => unit(lon, (u - 0.5) * 2 * Math.PI));
    }
    g.globalAlpha = 0.5;
    for (const lat of [-1.0, -0.5, 0, 0.5, 1.0])
      line((u) => unit(u * 2 * Math.PI, lat));
    g.setLineDash([]);
    // lights: one fill per size and brightness step (overlapping lights of one step do not add up)
    for (const b of buckets) b.length = 0;
    for (const L of lights) {
      const q = place(L.v, rot);
      const a = smooth((q.z - 0.02) / 0.3);
      if (a < 0.01) continue;
      const tw = L.tw ? 0.55 + 0.45 * Math.sin(t * L.tw + L.ph) : 1;
      const lv = Math.round(L.base * a * tw * LEVELS);
      if (lv < 1) continue;
      buckets[L.size * LEVELS + lv - 1]!.push([q.x, q.y]);
    }
    g.fillStyle = glow;
    buckets.forEach((b, j) => {
      if (!b.length) return;
      const rad = SIZES[Math.floor(j / LEVELS)]! / 2;
      g.globalAlpha = ((j % LEVELS) + 1) / LEVELS;
      g.beginPath();
      for (const [x, y] of b) {
        g.moveTo(x + rad, y);
        g.arc(x, y, rad, 0, 2 * Math.PI);
      }
      g.fill();
    });
    g.globalAlpha = 1;
  }

  // the arcs, the people and the packets, over everything
  function drawFront(rot: number) {
    const g = front.begin();
    if (!g) return;
    // arcs: drawn out, a packet riding their head, then fading from the tail
    const heads: { at: Pt; o: number; col: string }[] = [];
    g.lineWidth = ARC_W * k;
    g.lineCap = "round";
    g.lineJoin = "miter";
    for (const F of arcs) {
      const age = t - F.t0;
      const m = travel(age / ARC_DUR);
      const pts = arcPts(F, rot);
      const vis = Math.min(seen(place(F.A.v, rot)), seen(place(F.B.v, rot)));
      g.globalAlpha = 0.5 * vis * (1 - smooth((age - ARC_DUR) / 0.8));
      g.strokeStyle = F.col;
      g.beginPath();
      tracePart(g, pts, m);
      g.stroke();
      heads.push({
        at: alongPath(pts, m),
        o: vis * smooth(age / 0.25) * (1 - smooth((age - ARC_DUR + 0.2) / 0.2)),
        col: F.col,
      });
    }
    // people: their dots go round them, and they flare when something reaches them
    for (const P of people) {
      const q = place(P.v, rot);
      const a = seen(q);
      if (a < 0.01) continue;
      const fl = Math.exp(-Math.max(0, t - P.flare) * 2.2);
      const sc =
        0.85 + 0.15 * q.z + 0.25 * fl + 0.05 * Math.sin(t * 0.9 + P.ph);
      g.globalAlpha = a * (HALO + 0.4 * fl);
      g.fillStyle = glow;
      g.beginPath();
      g.arc(q.x, q.y, NODE.halo * sc, 0, 2 * Math.PI);
      g.fill();
      g.globalAlpha = a;
      P.dots.forEach((col, j) => {
        const an = P.ph + t * P.spin + j * 2.094;
        g.fillStyle = col;
        g.beginPath();
        g.arc(
          q.x + Math.cos(an) * NODE.orbit * sc,
          q.y + Math.sin(an) * NODE.orbit * 0.83 * sc,
          NODE.dot * sc,
          0,
          2 * Math.PI,
        );
        g.fill();
      });
    }
    // packets, over the people
    for (const h of heads) {
      if (h.o <= 0) continue;
      g.globalAlpha = h.o * PACKET_HALO;
      g.fillStyle = h.col;
      g.beginPath();
      g.arc(h.at[0], h.at[1], 9, 0, 2 * Math.PI);
      g.fill();
      g.globalAlpha = h.o;
      g.fillStyle = frost;
      g.beginPath();
      g.arc(h.at[0], h.at[1], 3.2, 0, 2 * Math.PI);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  function draw() {
    const rot = (t * 2 * Math.PI) / TURN;
    drawUnder(rot);
    drawFront(rot);
  }

  return {
    update(p) {
      // the lines are thinned back by as much as the frame is magnified
      k = Math.pow(r, Math.min(0, p - 5));
      // the engine has just placed the surfaces: repaint now, not a frame late beside the SVG frames
      draw();
    },
    tick(dt) {
      t += dt;
      const rot = (t * 2 * Math.PI) / TURN;
      while (t >= nextArc) {
        launch(rot);
        nextArc += ARC_EVERY;
      }
      draw();
      // an arc's receiver flares as its packet lands (seen from the next frame on); a faded arc is gone
      arcs = arcs.filter((F) => {
        const age = t - F.t0;
        if (age >= ARC_DUR - 0.1 && F.B.flare < F.t0) F.B.flare = t;
        return age <= ARC_DUR + 0.8;
      });
    },
  };
}
