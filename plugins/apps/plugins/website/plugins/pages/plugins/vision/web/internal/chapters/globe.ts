import {
  alongPath,
  n1,
  polyline,
  random,
  smooth,
  travel,
  type Pt,
} from "../kit/math";
import { C, OS_COL } from "../kit/palette";
import { circ, setAttr, svgEl } from "../kit/svg";
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
 */

const GR = 470;
const TURN = 110;
const TILT5 = 0.38;
const ARC_EVERY = 0.3;
const ARC_DUR = 2.4;
const PEOPLE = 44;
/** Lights: drawn as a few paths — one per size and brightness step — not one element each. */
const SIZES = [2.6, 4.6];
const LEVELS = 6;

type V3 = [number, number, number];
interface Person {
  v: V3;
  g: SVGGElement;
  halo: SVGCircleElement;
  dots: SVGCircleElement[];
  spin: number;
  ph: number;
  flare: number;
}
interface Arc {
  A: Person;
  B: Person;
  t0: number;
  path: SVGPathElement;
  pk: SVGGElement;
}

/**
 * `you.at`: your corner (frame 4's centre, where the zoom comes from), whose
 * nodes fly out to people of the globe (`world.claim`). `r`: how many times
 * bigger this frame is drawn while it is zoomed into (its lines thinned back by
 * as much).
 */
export function mountGlobe(
  front: SVGGElement,
  under: SVGGElement,
  you: { at: Pt },
  r: number,
  world: World,
): LiveFrame {
  const rnd = random(23);
  const HUE = OS_COL;
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

  // the grid: meridians and parallels, drawn on the side facing us
  const gridEls: SVGPathElement[] = [];
  for (let i = 0; i < 11; i++) {
    const gp = svgEl("path", {
      class: "zb-ring",
      opacity: i < 6 ? ".7" : ".5",
    });
    under.appendChild(gp);
    gridEls.push(gp);
  }
  const gridPath = (fn: (u: number) => V3, rot: number) => {
    let d = "";
    let on = false;
    for (let k = 0; k <= 128; k++) {
      const q = place(fn(k / 128), rot);
      if (q.z > 0) {
        d += `${on ? "L" : "M"}${n1(q.x)} ${n1(q.y)}`;
        on = true;
      } else on = false;
    }
    return d;
  };
  // the lights: towns around a few hubs
  const hubs: Pt[] = [];
  for (let i = 0; i < 16; i++) hubs.push([rnd() * 6.283, (rnd() - 0.5) * 2.2]);
  const buckets: SVGPathElement[] = [];
  for (const w of SIZES)
    for (let lv = 1; lv <= LEVELS; lv++) {
      const bp = svgEl("path", {
        fill: "none",
        stroke: C.glow,
        "stroke-linecap": "round",
        "stroke-width": w,
        opacity: (lv / LEVELS).toFixed(2),
      });
      under.appendChild(bp);
      buckets.push(bp);
    }
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
  // the people
  const gArcs = svgEl("g");
  const gPeople = svgEl("g");
  const gPk = svgEl("g");
  front.append(gArcs, gPeople, gPk);
  const people: Person[] = [];
  for (let i = 0; i < PEOPLE; i++) {
    // spread evenly over the globe (a Fibonacci sphere), a little off the grid
    const fz = 1 - (2 * (i + 0.5)) / PEOPLE;
    const hub: Pt = [i * 2.39996 + (rnd() - 0.5) * 0.3, Math.asin(fz) * 0.92];
    const g = svgEl("g");
    const halo = svgEl("circle", {
      class: "zb-halo",
      r: NODE.halo,
      fill: C.glow,
    });
    const dots: SVGCircleElement[] = [];
    g.appendChild(halo);
    for (let j = 0; j < 3; j++) {
      const d = svgEl("circle", {
        class: "zb-dot",
        r: NODE.dot,
        fill: HUE[Math.floor(rnd() * HUE.length)]!,
      });
      g.appendChild(d);
      dots.push(d);
    }
    gPeople.appendChild(g);
    const spin = (0.5 + rnd() * 0.7) * (rnd() < 0.5 ? -1 : 1);
    people.push({
      v: unit(hub[0], hub[1]),
      g,
      halo,
      dots,
      spin,
      ph: rnd() * 6.283,
      flare: -9,
    });
  }

  let t = 0;
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
    const col = HUE[Math.floor(rnd() * HUE.length)]!;
    const path = svgEl("path", {
      class: "zo5-arc",
      stroke: col,
      pathLength: "1",
      "stroke-dasharray": "1 1",
    });
    const pk = svgEl(
      "g",
      {},
      circ(0, 0, 9, "zb-halo", `fill="${col}" style="opacity:.35"`) +
        circ(0, 0, 3.2, "zb-dot", `fill="${C.frost}"`),
    );
    gArcs.appendChild(path);
    gPk.appendChild(pk);
    arcs.push({ A, B, t0: t, path, pk });
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

  function render() {
    const rot = (t * 2 * Math.PI) / TURN;
    // grid: each meridian path is a whole great circle (lon and lon + 180°), so the 6 cover the globe every 30°
    for (let m = 0; m < 6; m++) {
      const lon = (m * Math.PI) / 6;
      setAttr(
        gridEls[m]!,
        "d",
        gridPath((u) => unit(lon, (u - 0.5) * 2 * Math.PI), rot),
      );
    }
    [-1.0, -0.5, 0, 0.5, 1.0].forEach((lat, j) => {
      setAttr(
        gridEls[6 + j]!,
        "d",
        gridPath((u) => unit(u * 2 * Math.PI, lat), rot),
      );
    });
    // lights
    const ds = buckets.map(() => "");
    for (const L of lights) {
      const q = place(L.v, rot);
      const a = smooth((q.z - 0.02) / 0.3);
      if (a < 0.01) continue;
      const tw = L.tw ? 0.55 + 0.45 * Math.sin(t * L.tw + L.ph) : 1;
      const lv = Math.round(L.base * a * tw * LEVELS);
      if (lv < 1) continue;
      ds[L.size * LEVELS + lv - 1] += `M${n1(q.x)} ${n1(q.y)}h0`;
    }
    buckets.forEach((bp, j) => setAttr(bp, "d", ds[j]!));
    // people: their dots go round them, and they flare when something reaches them
    for (const P of people) {
      const q = place(P.v, rot);
      const a = seen(q);
      setAttr(P.g, "opacity", a.toFixed(3));
      if (a < 0.01) continue;
      const fl = Math.exp(-Math.max(0, t - P.flare) * 2.2);
      setAttr(
        P.g,
        "transform",
        `translate(${n1(q.x)} ${n1(q.y)}) scale(${(0.85 + 0.15 * q.z + 0.25 * fl + 0.05 * Math.sin(t * 0.9 + P.ph)).toFixed(3)})`,
      );
      P.halo.style.opacity = (0.14 + 0.4 * fl).toFixed(3);
      P.dots.forEach((d, j) => {
        const an = P.ph + t * P.spin + j * 2.094;
        setAttr(d, "cx", String(n1(Math.cos(an) * NODE.orbit)));
        setAttr(d, "cy", String(n1(Math.sin(an) * NODE.orbit * 0.83)));
      });
    }
    // arcs: drawn out, a packet riding their head, then fading from the tail
    arcs = arcs.filter((F) => {
      const age = t - F.t0;
      const m = travel(age / ARC_DUR);
      const pts = arcPts(F, rot);
      const vis = Math.min(seen(place(F.A.v, rot)), seen(place(F.B.v, rot)));
      setAttr(F.path, "d", polyline(pts));
      setAttr(F.path, "stroke-dashoffset", (1 - m).toFixed(3));
      setAttr(
        F.path,
        "opacity",
        (0.5 * vis * (1 - smooth((age - ARC_DUR) / 0.8))).toFixed(3),
      );
      const at = alongPath(pts, m);
      setAttr(F.pk, "transform", `translate(${n1(at[0])} ${n1(at[1])})`);
      setAttr(
        F.pk,
        "opacity",
        (
          vis *
          smooth(age / 0.25) *
          (1 - smooth((age - ARC_DUR + 0.2) / 0.2))
        ).toFixed(3),
      );
      if (age >= ARC_DUR - 0.1 && F.B.flare < F.t0) F.B.flare = t;
      if (age > ARC_DUR + 0.8) {
        gArcs.removeChild(F.path);
        gPk.removeChild(F.pk);
        return false;
      }
      return true;
    });
  }

  render();
  return {
    update(p) {
      const k = Math.pow(r, Math.min(0, p - 5)).toFixed(3);
      front.style.setProperty("--zo5-k", k);
      under.style.setProperty("--zo5-k", k);
    },
    tick(dt) {
      t += dt;
      const rot = (t * 2 * Math.PI) / TURN;
      while (t >= nextArc) {
        launch(rot);
        nextArc += ARC_EVERY;
      }
      render();
    },
  };
}
