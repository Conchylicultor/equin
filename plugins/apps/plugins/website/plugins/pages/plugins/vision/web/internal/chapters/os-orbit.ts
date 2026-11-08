import { io, latch, n1, random, smooth } from "../kit/math";
import { gpath, grect, type OsKind } from "../kit/night";
import { C } from "../kit/palette";
import { circ, rect, setAttr, svgEl } from "../kit/svg";
import type { ApartWindow, Place } from "./apart";
import { IN } from "./geometry";
import { simpleApp, sphere } from "./orbit-kit";

/**
 * Chapter 3 — the desktop as an orbit: its apps float freely on a slowly
 * turning sphere above a dock, seen in real perspective (depth-sorted, the far
 * side smaller and dimmer). As chapter 2 comes apart, its apps fly out onto the
 * sphere and each gets its icon in the dock. Then the desktop lives: now and
 * then a new app launches out of a new dock icon onto a free place of the
 * sphere, and an old one closes back into its icon, which leaves the dock.
 * Leaving for chapter 4 (p past ~3.12), nothing new launches, the dock goes and
 * the apps turn into plain shapes, like everyone else's orbit there.
 */

// ---- the sphere (frame 3 units) ----
const R = 290;
const RX = 1.3;
const CY = -44;
const D = 900;
const TILT = 0.18;
const SPIN = (2 * Math.PI) / 56; // one turn in 56 s
/**
 * Ten places a tenth of a turn apart, alternately on the upper and the lower
 * ring, with their nominal window sizes (at perspective scale 1). They are
 * listed so the first six (chapter 2's apps) are spread all around the sphere,
 * three up and three down; the rest stay free for apps launched later.
 */
const LAT = 0.42;
const SPREAD = [0, 2, 5, 7, 3, 8, 1, 4, 6, 9];
const SLOT_W = [188, 165, 198, 175, 192, 160, 182, 170, 190, 162];
const SLOT_H = [130, 142, 122, 135, 125, 145, 128, 138, 125, 140];
const SLOTS = SPREAD.map((k, si) => ({
  lon: (k * Math.PI) / 5 + 0.25,
  lat: k % 2 ? -LAT : LAT,
  W: SLOT_W[si]!,
  H: SLOT_H[si]!,
}));
const proj = sphere({ R, RX, CY, D, TILT });
const slotAt = (slot: number, rot: number) => {
  const s = SLOTS[slot]!;
  return proj(s.lon, s.lat, rot);
};

const DIM = C.dim;

// ---- the loop: every EV seconds an app launches (+1) or closes (-1), by PATTERN ----
const EV = 3.4;
const EV0 = 1.2;
const LAUNCH = 1.2;
const CLOSE = 1.0;
const PATTERN = [1, -1, 1, 1, -1, -1];
const NEW: readonly OsKind[] = ["chart", "doc", "keys", "grid", "list", "chat"];
const NEW_COL = [C.periwinkle, C.teal, C.ice, C.sky, C.aqua, C.azure];
// the dock (frame 3 units): its centre line, and the room one icon takes
const DOCK_Y = 312;
const ICON = 40;
/** How many times smaller frame 3 is in frame 4 (its lines thicken by as much as it shrinks). */
const ZOOM4 = IN[3]!.r;

type Part = {
  t: "bar" | "side" | "list" | "body" | "btn";
  x: number;
  y: number;
  w: number;
  h: number;
  right?: boolean;
};

/**
 * What each window kind is made of, laid out for its nominal size (centred on
 * 0, 0); rnd (the app's own seed) varies the layout — a side pane or not, on
 * which side, how wide, a row of buttons or not — so two apps of a kind never
 * look the same.
 */
function partsOf(
  kind: OsKind,
  W: number,
  H: number,
  rnd: () => number,
): Part[] {
  const x0 = -W / 2;
  const y0 = -H / 2;
  const BAR = 20;
  const BTN = 22;
  const sw = Math.round(W * (0.24 + 0.12 * rnd()));
  const sideOdds: Partial<Record<OsKind, number>> = {
    doc: 0.8,
    chat: 0.7,
    grid: 0.7,
    chart: 0.7,
  };
  const btnOdds: Partial<Record<OsKind, number>> = {
    doc: 0.7,
    chat: 0.8,
    grid: 0.6,
    list: 0.7,
    keys: 0.8,
  };
  const side = rnd() < (sideOdds[kind] ?? 0.25);
  const right = side && rnd() < 0.3;
  const btn = rnd() < (btnOdds[kind] ?? 0.35);
  const cx = x0 + (side && !right ? sw : 0);
  const cw = W - (side ? sw : 0);
  const ch = H - BAR - (btn ? BTN : 0);
  const P: Part[] = [{ t: "bar", x: x0, y: y0, w: W, h: BAR }];
  if (side)
    P.push({
      t: "side",
      x: right ? x0 + W - sw : x0,
      y: y0 + BAR,
      w: sw,
      h: H - BAR,
      right,
    });
  P.push({
    t: kind === "chat" || kind === "list" ? "list" : "body",
    x: cx,
    y: y0 + BAR,
    w: cw,
    h: ch,
  });
  if (btn) P.push({ t: "btn", x: cx, y: y0 + H - BTN, w: cw, h: BTN });
  return P;
}

function content(
  p: Part,
  kind: OsKind,
  col: string,
  rnd: () => number,
): string {
  const { x, y, w, h } = p;
  let o = "";
  let d = "";
  const len = () => 0.45 + 0.55 * rnd();
  switch (p.t) {
    case "bar":
      return (
        `<path class="zb-l" stroke="${col}" opacity=".5" d="M${x} ${y + h}h${w}"/>` +
        circ(x + 11, y + 10, 2.8, "zb-dot", `fill="${col}"`) +
        circ(x + 21, y + 10, 2.8, "zb-dot", `fill="${col}"`) +
        rect(
          n1(x + w - 30),
          y + 6,
          8,
          8,
          "zb-mini",
          2,
          `style="stroke:${DIM}"`,
        ) +
        rect(n1(x + w - 18), y + 6, 8, 8, "zb-mini", 2, `style="stroke:${DIM}"`)
      );
    case "side": {
      o += `<path class="zb-l" stroke="${col}" opacity=".4" d="M${p.right ? x : x + w} ${y}v${h}"/>`;
      const n = Math.min(3 + Math.floor(rnd() * 4), Math.floor((h - 8) / 14));
      const lit = Math.floor(rnd() * Math.min(n, 3));
      for (let i = 0; i < n; i++) {
        const yy = y + 12 + i * 14;
        const on = i === lit;
        o +=
          circ(x + 9, yy, 2, "zb-dot", `fill="${on ? col : DIM}"`) +
          gpath(
            `M${x + 16} ${yy}h${n1((w - 24) * len())}`,
            on ? col : DIM,
            'opacity=".75"',
          );
      }
      return o;
    }
    case "list": {
      if (kind === "chat") {
        const n = Math.floor((h - 8) / 17);
        const first = rnd() < 0.5 ? 1 : 0;
        for (let i = 0; i < n; i++) {
          const me = (i + first) % 2 === 1;
          const bw = n1((w - 16) * (me ? 0.35 : 0.45) * (1 + len() * 0.6));
          const bx = me ? n1(x + w - 8 - bw) : x + 8;
          o += rect(
            bx,
            y + 7 + i * 17,
            bw,
            11,
            "zb-bubble",
            5,
            `style="stroke:${me ? col : DIM};fill:${me ? col : DIM}"`,
          );
        }
        return o;
      }
      const n = Math.floor((h - 6) / 15);
      const lo1 = Math.floor(rnd() * Math.min(n, 4));
      for (let i = 0; i < n; i++) {
        const ly = y + 11 + i * 15;
        const lo = i === lo1;
        o +=
          circ(x + 11, ly, 2.4, "zb-dot", `fill="${lo ? col : DIM}"`) +
          gpath(
            `M${x + 20} ${ly}h${n1((w - 30) * len())}`,
            lo ? col : DIM,
            'opacity=".75"',
          );
      }
      return o;
    }
    case "body": {
      const ix = x + 9;
      const iy = y + 9;
      const iw = w - 18;
      const ih = h - 16;
      if (kind === "chart") {
        // a chart: a line climbing (or falling) in steps, each rise with its dip, its own for each app
        const np = 6 + Math.floor(rnd() * 3);
        const up = rnd() < 0.8;
        const from = 0.75 + 0.1 * rnd();
        const to = 0.12 + 0.15 * rnd();
        for (let i = 0; i < np; i++) {
          const f = i / (np - 1);
          let v =
            from +
            (to - from) * f +
            (i % 2 ? 0.16 : -0.04) *
              (0.6 + 0.8 * rnd()) *
              (i && i < np - 1 ? 1 : 0);
          if (!up) v = 1 - v;
          d += `${i ? "L" : "M"}${n1(ix + iw * f)} ${n1(iy + ih * 0.85 * Math.max(0.04, Math.min(0.96, v)))}`;
        }
        return (
          gpath(d, col) +
          gpath(`M${ix} ${n1(iy + ih * 0.92)}h${n1(iw)}`, DIM, 'opacity=".6"')
        );
      }
      if (kind === "grid") {
        const cols = Math.max(2, Math.floor((iw + 6) / (20 + rnd() * 16)));
        const rows = Math.max(1, Math.floor((ih + 6) / (20 + rnd() * 12)));
        const lit = Math.floor(rnd() * 3);
        const tw = (iw - (cols - 1) * 6) / cols;
        const th = (ih - (rows - 1) * 6) / rows;
        for (let i = 0; i < rows; i++)
          for (let j = 0; j < cols; j++)
            o += rect(
              n1(ix + j * (tw + 6)),
              n1(iy + i * (th + 6)),
              n1(tw),
              n1(th),
              "zb-mini",
              4,
              `style="stroke:${(i * cols + j) % 3 === lit ? col : DIM}"`,
            );
        return o;
      }
      if (kind === "keys") {
        const nk = Math.max(4, Math.floor(iw / 13));
        const kw = iw / nk;
        const ky = n1(iy + ih * 0.45);
        for (let i = 0; i < nk; i++)
          o += rect(
            n1(ix + i * kw),
            ky,
            n1(kw - 2.5),
            n1(ih * 0.55),
            "zb-key",
            2,
          );
        const notes = 3 + Math.floor(rnd() * 3);
        for (let i = 0; i < notes; i++)
          o += rect(
            n1(ix + Math.floor(rnd() * nk) * kw + 2),
            n1(iy + rnd() * ih * 0.28),
            n1(Math.max(2, kw - 6)),
            n1(ih * 0.14),
            "zb-note2",
            2,
          );
        return o;
      }
      // doc
      o += gpath(
        `M${ix} ${iy + 3}h${n1(iw * (0.3 + 0.35 * rnd()))}`,
        col,
        'class="zb-thick"',
      );
      const n = Math.floor((ih - 10) / 11);
      for (let i = 0; i < n; i++)
        d += `M${ix} ${n1(iy + 16 + i * 11)}h${n1(iw * (i % 4 === 3 ? 0.3 + 0.3 * rnd() : len()))}`;
      return o + gpath(d, DIM, 'opacity=".7"');
    }
    case "btn":
      return (
        rect(
          n1(x + w - 40),
          y + 5,
          30,
          12,
          "zb-chip",
          6,
          `style="stroke:${col};fill:${col}"`,
        ) +
        rect(
          n1(x + w - 66),
          y + 5,
          20,
          12,
          "zb-chip",
          6,
          `style="stroke:${DIM};fill:${DIM}"`,
        )
      );
  }
}

/** The window: its frame, then its parts. */
function windowSvg(
  kind: OsKind,
  col: string,
  W: number,
  H: number,
  seed: number,
): string {
  const rnd = random(seed ^ 0x5bd1e995);
  let o =
    rect(-W / 2, -H / 2, W, H, "zb-pop", 10) +
    grect(-W / 2, -H / 2, W, H, 10, col);
  for (const p of partsOf(kind, W, H, rnd)) o += content(p, kind, col, rnd);
  return o;
}

/** A dock icon, centred on 0, 0: the app's colour, a hint of its kind, and the running dot below. */
function iconSvg(kind: OsKind, col: string): string {
  let o =
    rect(-13, -13, 26, 26, "zb-mini", 7, `style="stroke:${col}"`) +
    rect(-6, -6, 12, 4, "zb-dot", 2, `fill="${col}" opacity=".7"`);
  o += gpath(
    kind === "chart"
      ? "M-6 7L-2 2L1 4L6 -1"
      : kind === "keys"
        ? "M-6 1v6M-2 1v6M2 1v6M6 1v6"
        : kind === "grid"
          ? "M-6 1h4v5h-4zM2 1h4v5h-4z"
          : "M-6 2h12M-6 6h8",
    col,
    'opacity=".75"',
  );
  return o + circ(0, 18, 1.8, "zb-dot", `fill="${col}"`);
}

/** A window of the desktop. */
interface Win {
  fx: SVGGElement;
  /** Chapter 2's drawing of it (the apart() copy), or null for an app launched here. */
  eng: SVGGElement | null;
  slot: number;
  kind: OsKind;
  col: string;
  seed: number;
  /** Where apart() drew it. */
  pl: { cx: number; cy: number; f: number };
  /** -Infinity for chapter 2's apps. */
  born: number;
  /** null while open. */
  died: number | null;
  gone: boolean;
  W: number;
  H: number;
  mine: SVGGElement;
  detail: SVGGElement;
  simple: SVGGElement;
  icon: SVGGElement;
  dw: number;
  dx: number;
}

/** A free place of your orbit an app flying in from someone else's (chapter 4) may take. */
export interface HomePlace {
  slot: number;
  W: number;
  H: number;
  /** Where it is now, in frame 4 units; f its perspective scale. */
  pos(): { x: number; y: number; f: number; z: number };
  cancel(): void;
}
/** An app flying between orbits. */
export interface FlyingApp {
  col: string;
  seed: number;
  W: number;
  H: number;
}
/** Your orbit, as chapter 4 trades apps with it. */
export interface Home {
  adopt(): HomePlace | null;
  land(place: HomePlace, app: FlyingApp): void;
  release():
    | (FlyingApp & { pos(): { x: number; y: number; f: number; z: number } })
    | null;
}

export interface OrbitDesktop {
  /** The rects the windows settle into: one per place, for chapter 2's apps. */
  places(): Place[];
  /** The desktop's windows, from apart(); [] when gone. */
  windows(list: ApartWindow[]): void;
  /** On scroll: p the zoom progress, settle 0 → 1 as the windows reach their places. */
  update(p: number, settle: number): void;
  /** Every frame while on screen (seconds). */
  tick(dt: number): void;
  /** `to4` maps frame 3 units to frame 4's (x, y, and the scale). */
  home(to4: (x: number, y: number) => [number, number, number]): Home;
}

/** `back` / `front`: the frame 3 layers behind / in front of the windows. */
export function mountOrbitDesktop(
  back: SVGGElement,
  front: SVGGElement,
  prefix: string,
): OrbitDesktop {
  // a window as drawn here: in full, and as the plain shape it reads as once zoomed out (chapter 4)
  // (each app its own seed: no two plain shapes alike)
  const seeds = random(5);
  function drawing(
    w: Omit<
      Win,
      "mine" | "detail" | "simple" | "W" | "H" | "seed" | "icon" | "dw" | "dx"
    > & { seed?: number },
    attrs: Record<string, string> | null,
    W: number,
    H: number,
  ): Win {
    const seed = w.seed || Math.floor(seeds() * 1e9);
    const mine = svgEl("g", attrs ?? {});
    const detail = svgEl("g", {}, windowSvg(w.kind, w.col, W, H, seed));
    const simple = svgEl(
      "g",
      { opacity: "0", class: "zo-plain" },
      simpleApp(w.col, W, H, seed, w.kind),
    );
    mine.appendChild(detail);
    mine.appendChild(simple);
    return {
      ...w,
      seed,
      W,
      H,
      mine,
      detail,
      simple,
      icon: svgEl("g", {}, iconSvg(w.kind, w.col)),
      dw: 0,
      dx: 0,
    };
  }

  // the orbit's rings and a soft light at its centre, behind everything
  const gBack = svgEl("g", { opacity: "0" });
  back.appendChild(gBack);
  const ringD = (lat: number) => {
    let d = "";
    for (let i = 0; i <= 72; i++) {
      const q = proj((i * Math.PI) / 36, lat, 0);
      d += `${i ? "L" : "M"}${n1(q.x)} ${n1(q.y)}`;
    }
    return d;
  };
  gBack.innerHTML =
    `<defs><radialGradient id="${prefix}zo-glow"><stop offset="0" stop-color="${C.ice}" stop-opacity=".3"/><stop offset=".4" stop-color="${C.azure}" stop-opacity=".1"/><stop offset="1" stop-color="${C.azure}" stop-opacity="0"/></radialGradient></defs>` +
    `<circle cx="0" cy="${CY}" r="200" fill="url(#${prefix}zo-glow)"/>` +
    `<path class="zo-ring" d="${ringD(LAT)}"/><path class="zo-ring" d="${ringD(-LAT)}"/><path class="zo-ring" opacity=".55" d="${ringD(0)}"/>`;

  // the dock, in front of the windows as on a real desktop: opaque, so a window passing behind it is hidden, not seen through
  const gDock = svgEl("g", { opacity: "0" });
  const pillBg = svgEl("rect", {
    class: "zb-dockbg",
    y: DOCK_Y - 22,
    height: 44,
    rx: 22,
  });
  const pill = svgEl("rect", {
    class: "zb-pill zb-dim",
    y: DOCK_Y - 22,
    height: 44,
    rx: 22,
  });
  gDock.appendChild(pillBg);
  gDock.appendChild(pill);
  front.appendChild(gDock);

  // ---- state ----
  let wins: Win[] = [];
  let holder: Element | null = null;
  let mix = 0;
  let t = 0;
  let ft = 0;
  let P = 0;
  let settle = 0;
  let order = "";
  let nev = 0;
  let nnew = 0;
  let held = new Set<number>(); // places promised to an app flying in from someone else's orbit (chapter 4)

  const free = (slot: number) =>
    !held.has(slot) && !wins.some((w) => !w.gone && w.slot === slot);
  const addIcon = (w: Win) => gDock.appendChild(w.icon);
  const openWins = () => wins.filter((w) => !w.gone && w.died == null);
  /** The free place nearest the front at `rot`, or -1. */
  const frontmostFree = (rot: number) => {
    let best = -1;
    let bz = -1e9;
    SLOTS.forEach((s, i) => {
      if (!free(i)) return;
      const z = proj(s.lon, s.lat, rot).z;
      if (z > bz) {
        bz = z;
        best = i;
      }
    });
    return best;
  };

  // one event of the loop: a launch or a close, by the pattern
  function event(k: number) {
    const rot = (ft + LAUNCH) * SPIN;
    const open = openWins();
    if (PATTERN[k % PATTERN.length]! > 0) {
      // launch onto the free place nearest the front when it lands
      const best = frontmostFree(rot);
      if (best < 0) return;
      // a kind and a colour not already open, when there is one
      const unused = <T>(list: readonly T[], key: (w: Win) => T) => {
        const u = list.filter((v) => !open.some((w) => key(w) === v));
        return u.length ? u : list;
      };
      const kinds = unused(NEW, (w) => w.kind);
      const cols = unused(NEW_COL, (w) => w.col);
      openAt(
        best,
        kinds[nnew % kinds.length]!,
        cols[(nnew * 5) % cols.length]!,
        ft,
      );
      nnew++;
    } else {
      // close the app open the longest (of chapter 2's, the one nearest the front)
      let pickW: Win | null = null;
      for (const w of open) {
        if (ft - w.born < 2 * EV) continue;
        if (
          !pickW ||
          w.born < pickW.born ||
          (w.born === pickW.born &&
            slotAt(w.slot, rot).z > slotAt(pickW.slot, rot).z)
        )
          pickW = w;
      }
      if (pickW) pickW.died = ft;
    }
  }
  // (W, H: its size at perspective scale 1 — the place's own, unless it arrives with a shape of its own)
  function openAt(
    slot: number,
    kind: OsKind,
    col: string,
    born: number,
    seed?: number,
    W?: number,
    H?: number,
  ): Win {
    const s = SLOTS[slot]!;
    const fx = svgEl("g");
    const w = drawing(
      {
        fx,
        eng: null,
        slot,
        kind,
        col,
        seed,
        pl: { cx: 0, cy: 0, f: 1 },
        born,
        died: null,
        gone: false,
      },
      null,
      W || s.W,
      H || s.H,
    );
    fx.appendChild(w.mine);
    holder!.appendChild(fx);
    wins.push(w);
    addIcon(w);
    return w;
  }
  function step() {
    while (P <= 3.12 && ft >= EV0 + nev * EV) {
      event(nev);
      nev++;
    }
    for (const w of wins) {
      if (w.gone || w.died == null || ft - w.died < CLOSE + 0.6) continue;
      w.gone = true;
      w.fx.style.display = "none";
      gDock.removeChild(w.icon);
    }
  }

  // chapter 2's drawing of a window hands over to this one on a short timed fade once the desktop has
  // nearly settled — never part-way with the scroll, so a pause can't leave both drawings on screen.
  // Latched: a page at rest a few pixels either side of the hand-off (a phone's scroll under a thumb)
  // would otherwise start the fade, turn it back, start it again — a flicker through the dark ground
  // both drawings show at half opacity.
  const handedOver = latch(0.85, 0.6);
  const mixTarget = () => (handedOver(settle) ? 1 : 0);

  function render() {
    const on = wins.length > 0;
    const sw = smooth(settle);
    const show = on ? smooth((settle - 0.45) / 0.55) : 0;
    setAttr(
      gBack,
      "opacity",
      (show * 0.75 * (1 - smooth((P - 4.15) / 0.5))).toFixed(3),
    );
    // zooming out to chapter 4: the dock goes, and the apps become the plain shapes everyone's are drawn as
    const plain = smooth((P - 3.08) / 0.4);
    // leaving chapter 4 for 5, your orbit becomes a node like everyone's (drawn by shared.ts): it fades out
    const away = 1 - smooth((P - 4.15) / 0.5);
    if (holder instanceof SVGElement) {
      holder.style.opacity = away.toFixed(3);
      holder.style.setProperty(
        "--zo-k",
        Math.pow(ZOOM4, Math.max(0, Math.min(1, P - 3))).toFixed(3),
      );
    }
    setAttr(
      gDock,
      "opacity",
      (show * (1 - smooth((P - 3.05) / 0.3))).toFixed(3),
    );
    if (!on) return;
    const rot = t * SPIN;

    // the dock: each icon takes its share of the row as it arrives or leaves
    const live = wins.filter((w) => !w.gone);
    let total = 0;
    for (const w of live) {
      w.dw =
        w.died != null
          ? 1 - smooth((ft - w.died - CLOSE + 0.1) / 0.5)
          : smooth((ft - w.born) / 0.4);
      total += w.dw * ICON;
    }
    let x = -total / 2;
    for (const w of live) {
      w.dx = x + (w.dw * ICON) / 2;
      x += w.dw * ICON;
      const hop =
        w.died == null && ft - w.born < 1.4
          ? -9 *
            Math.abs(Math.sin((Math.PI * (ft - w.born)) / 0.7)) *
            (1 - (ft - w.born) / 1.4)
          : 0;
      setAttr(
        w.icon,
        "transform",
        `translate(${n1(w.dx)} ${n1(DOCK_Y + hop)}) scale(${w.dw.toFixed(3)})`,
      );
    }
    for (const r of [pill, pillBg]) {
      setAttr(r, "x", String(n1(-total / 2 - 12)));
      setAttr(r, "width", String(n1(total + 24)));
    }

    // the windows: on the sphere, or on their way from or into their dock icon
    const keys: { key: number; w: Win }[] = [];
    for (const w of live) {
      const q = slotAt(w.slot, rot);
      const m =
        w.died != null
          ? 1 - io((ft - w.died) / CLOSE)
          : io((ft - w.born - 0.25) / LAUNCH);
      const k0 = 26 / w.W;
      let X = w.dx + (q.x - w.dx) * m;
      let Y = DOCK_Y + (q.y - DOCK_Y) * m;
      let S = k0 + (q.f - k0) * m;
      const op = smooth(m / 0.15);
      // chapter 2's apps blend from where apart() put them to their live pose as the desktop settles
      const pl = w.pl;
      if (w.eng) {
        X = pl.cx + (X - pl.cx) * sw;
        Y = pl.cy + (Y - pl.cy) * sw;
        S = pl.f + (S - pl.f) * sw;
      }
      setAttr(
        w.fx,
        "transform",
        `translate(${n1(X)} ${n1(Y)}) scale(${(S / pl.f).toFixed(4)}) translate(${n1(-pl.cx)} ${n1(-pl.cy)})`,
      );
      setAttr(w.fx, "opacity", op.toFixed(3));
      setAttr(w.detail, "opacity", (1 - plain).toFixed(3));
      setAttr(w.simple, "opacity", plain.toFixed(3));
      if (w.eng) {
        const mo = smooth(mix);
        setAttr(w.mine, "opacity", mo.toFixed(3));
        w.eng.style.opacity = (1 - mo).toFixed(3);
      }
      keys.push({ key: q.z + (1 - m) * 2000, w });
    }
    keys.sort((A, B) => A.key - B.key);
    const sig = keys.map((k) => wins.indexOf(k.w)).join(",");
    if (sig !== order && holder) {
      order = sig;
      for (const k of keys) holder.appendChild(k.w.fx);
    }
  }

  return {
    places() {
      const rot = t * SPIN;
      return SLOTS.slice(0, 6).map((s, i) => {
        const q = proj(s.lon, s.lat, rot);
        const w = s.W * q.f;
        const h = s.H * q.f;
        return {
          x: n1(q.x - w / 2),
          y: n1(q.y - h / 2),
          w: n1(w),
          h: n1(h),
          slot: i,
          cx: q.x,
          cy: q.y,
          f: q.f,
        };
      });
    },
    windows(list) {
      for (const w of wins) {
        if (w.eng) {
          w.mine.remove();
          w.fx.removeAttribute("transform");
          w.fx.removeAttribute("opacity");
          w.fx.style.display = "";
          w.eng.style.opacity = "";
        } else w.fx.remove();
        if (w.icon.parentNode) gDock.removeChild(w.icon);
      }
      wins = [];
      order = "";
      ft = 0;
      nev = 0;
      nnew = 0;
      mix = 0;
      held = new Set();
      if (!list.length) {
        render();
        return;
      }
      holder = list[0]!.fx.parentNode as Element;
      wins = list.map((it) => {
        const pl = it.place;
        const s = SLOTS[pl.slot]!;
        const w = drawing(
          {
            fx: it.fx,
            eng: it.fx.firstChild as SVGGElement,
            slot: pl.slot,
            kind: it.kind,
            col: it.col,
            pl,
            born: -Infinity,
            died: null,
            gone: false,
          },
          {
            opacity: "0",
            transform: `translate(${n1(pl.cx)} ${n1(pl.cy)}) scale(${pl.f.toFixed(4)})`,
          },
          s.W,
          s.H,
        );
        it.fx.appendChild(w.mine);
        addIcon(w);
        return w;
      });
      render();
    },
    update(p, s) {
      P = p;
      settle = s;
      render();
    },
    home(to4) {
      // where a place is now, in frame 4 units; f is its perspective scale (sizes below are already in frame 4 units)
      const where = (slot: number) => {
        const q = slotAt(slot, t * SPIN);
        const a = to4(q.x, q.y);
        return { x: a[0], y: a[1], f: q.f, z: q.z };
      };
      // trading starts once chapter 4 is on screen: never under the eyes of someone still on chapter 3
      const ready = () => wins.length > 0 && settle >= 0.999 && P >= 3.8;
      return {
        adopt() {
          if (!ready()) return null;
          // the free place nearest the front when it lands
          const best = frontmostFree((t + 2.3) * SPIN);
          if (best < 0) return null;
          held.add(best);
          const sc = to4(0, 0)[2];
          return {
            slot: best,
            W: SLOTS[best]!.W * sc,
            H: SLOTS[best]!.H * sc,
            pos: () => where(best),
            cancel: () => held.delete(best),
          };
        },
        land(place, app) {
          held.delete(place.slot);
          // the app keeps the shape it flew in with (its width the place's), so it lands without a jump
          const W = SLOTS[place.slot]!.W;
          const w = openAt(
            place.slot,
            "doc",
            app.col,
            ft - 10,
            app.seed,
            W,
            (app.H * W) / app.W,
          );
          setAttr(w.simple, "opacity", "1");
          setAttr(w.detail, "opacity", "0");
          render();
        },
        release() {
          if (!ready()) return null;
          const open = openWins();
          if (open.length <= 4) return null;
          // the one nearest the front
          const pickW = open.reduce((a, w) =>
            slotAt(w.slot, t * SPIN).z > slotAt(a.slot, t * SPIN).z ? w : a,
          );
          const sc = to4(0, 0)[2];
          const from = where(pickW.slot);
          pickW.gone = true;
          pickW.fx.style.display = "none";
          gDock.removeChild(pickW.icon);
          return {
            col: pickW.col,
            seed: pickW.seed,
            W: pickW.W * sc,
            H: pickW.H * sc,
            pos: () => from,
          };
        },
      };
    },
    tick(dt) {
      if (!wins.length) return;
      t += dt;
      const mt = mixTarget();
      mix =
        mt > mix ? Math.min(mt, mix + dt / 0.3) : Math.max(mt, mix - dt / 0.3);
      if (settle >= 0.999) {
        ft += dt;
        step();
      }
      render();
    },
  };
}
