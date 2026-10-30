// The generic film renderer, run in the film page. It builds the DOM ONCE
// from a Composition (images decoded, fonts loaded) and then `renderAt(t)`
// sets every style from the composition's tracks at t — a pure function of t:
// no CSS transitions or animations, no timers, nothing read back from the
// previous frame. Nothing here knows any one film.

import type { AssetManifest, Still } from "../assets";
import type {
  Camera,
  Composition,
  GroupLayer,
  Layer,
  LayerBase,
  MotionBlur,
  Shape,
  TextLayer,
  Vec2,
} from "../composition";
import { ease } from "../easing";
import { sample, type Track, type Value } from "../tracks";

export const ASSET_PREFIX = "/__film/assets/";

type El = HTMLElement;

/** One built layer: its box element and what to update per frame. */
interface Node {
  layer: Layer;
  el: El;
  parent: Node | null;
  /** Box size at t (an image crop or a shape size may animate). */
  size(t: number): Vec2;
  /** Per-kind content update (frame pick, crop, reveal…). */
  update(t: number): void;
  children: Node[];
}

const px = (n: number): string => `${round(n)}px`;
/** Rounded so a style string never depends on float noise beyond 1e-4. */
const round = (n: number): string => (Math.round(n * 1e4) / 1e4).toString();
const clamp = (x: number, lo = 0, hi = 1): number =>
  Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const val = <V extends Value>(
  tr: Track<V> | undefined,
  t: number,
  dflt: V,
): V => (tr === undefined ? dflt : sample(tr, t));

function h(tag: string, parent: Element | null, cls?: string): El {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

/** Set styles, skipping unchanged values (only to spare style recalcs; the result is the same). */
function S(el: El, styles: Record<string, string>): void {
  for (const k in styles) {
    const v = styles[k] as string;
    if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v);
  }
}

const CURSOR_SVG = (size: number): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="M5 2.5v17.2l4.3-4.1 2.7 6.2 3-1.3-2.7-6.1h6z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

const BASE_CSS = `
html,body{margin:0;padding:0;overflow:hidden;background:#000}
*{box-sizing:border-box}
#stage,#overlay{position:absolute;left:0;top:0;overflow:hidden}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.L{position:absolute;left:0;top:0;transform-origin:0 0}
.L img{position:absolute;left:0;top:0;display:block;max-width:none;user-select:none}
.T{font-family:'Inter Variable',Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:'cv11','ss01';white-space:pre-wrap}
.T .w{display:inline-block;white-space:nowrap}
.T .u{display:inline-block;transform-origin:50% 80%}
.cursor svg{position:absolute;left:0;top:0;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
.cursor .ring{position:absolute;left:0;top:0;border-radius:50%;opacity:0}
`;

export interface FilmPage {
  ready(): Promise<void>;
  renderAt(t: number): Promise<void>;
}

export function installRenderer(comp: Composition): FilmPage {
  const W = comp.width;
  const H = comp.height;
  const manifest: AssetManifest = comp.assets.manifest;
  const imgs: HTMLImageElement[] = [];
  /** Frame decodes the current renderAt started; it waits for them. */
  let decoding: Promise<void>[] = [];
  const byId = new Map<string, Node>();

  const style = h("style", document.head);
  style.textContent = BASE_CSS + (comp.css ?? "");
  document.body.style.background = comp.background ?? "#000";

  const stage = h("div", document.body);
  stage.id = "stage";
  const cam: Camera = comp.camera ?? {};
  S(stage, {
    width: px(W),
    height: px(H),
    background: comp.background ?? "#000",
    perspective: px(cam.perspective ?? 1600),
    "perspective-origin": "50% 50%",
  });
  const world = h("div", stage);
  world.id = "world";
  S(world, { width: px(W), height: px(H) });
  const overlay = h("div", document.body);
  overlay.id = "overlay";
  S(overlay, { width: px(W), height: px(H) });

  const still = (name: string): Still => {
    const s = manifest.stills[name];
    if (!s) throw new Error(`film: the manifest has no still "${name}"`);
    return s;
  };
  const img = (
    parent: El,
    file: string,
    w: number,
    hgt: number,
  ): HTMLImageElement => {
    const i = document.createElement("img");
    i.decoding = "sync";
    i.src = ASSET_PREFIX + encodeURIComponent(file);
    i.width = w;
    i.height = hgt;
    S(i, { width: px(w), height: px(hgt) });
    parent.appendChild(i);
    imgs.push(i);
    return i;
  };

  // ------------------------------------------------------------ builders ----

  const buildText = (layer: TextLayer, el: El): ((t: number) => void) => {
    el.classList.add("T");
    S(el, {
      "font-size": px(layer.size),
      "font-weight": String(layer.weight ?? 600),
      color: layer.color ?? "#fff",
      "line-height": String(layer.lineHeight ?? 1.15),
      "letter-spacing": layer.letterSpacing ?? "-0.02em",
      "text-align": layer.align ?? "left",
      ...(layer.width !== undefined
        ? { width: px(layer.width) }
        : { "white-space": "pre" }),
    });
    const runs =
      typeof layer.text === "string" ? [{ text: layer.text }] : layer.text;
    const units: El[] = [];
    const rv = layer.reveal;
    for (const run of runs) {
      const host = h("span", el);
      if (run.style) S(host, run.style);
      if (!rv) {
        host.textContent = run.text;
        continue;
      }
      // Words as unbreakable boxes (letters inside), spaces as text between.
      const parts = run.text.split(/(\s+)/);
      for (const part of parts) {
        if (part === "") continue;
        if (/^\s+$/.test(part)) {
          host.appendChild(document.createTextNode(part));
          continue;
        }
        const w = h("span", host, "w");
        if (rv.by === "word") {
          w.classList.add("u");
          w.textContent = part;
          units.push(w);
        } else {
          for (const ch of Array.from(part)) {
            const u = h("span", w, "u");
            u.textContent = ch;
            units.push(u);
          }
        }
      }
    }
    if (!rv) return () => undefined;
    return (t) => {
      units.forEach((u, i) => {
        const p = ease(
          rv.easing ?? "outCubic",
          clamp((t - rv.at - i * rv.stagger) / rv.duration),
        );
        const q = 1 - p;
        const s = lerp(rv.fromScale ?? 1, 1, p);
        S(u, {
          opacity: round(p),
          transform: `translate(${px((rv.fromX ?? 0) * q)},${px((rv.fromY ?? 0) * q)}) scale(${round(s)})`,
          filter:
            (rv.fromBlur ?? 0) * q > 0.01
              ? `blur(${px((rv.fromBlur ?? 0) * q)})`
              : "none",
        });
      });
    };
  };

  const buildShape = (
    shape: Shape,
    el: El,
  ): { size: (t: number) => Vec2; update: (t: number) => void } => {
    switch (shape.kind) {
      case "rect":
        S(el, {
          background: shape.fill,
          "border-radius": px(shape.radius ?? 0),
          ...(shape.border ? { border: shape.border } : {}),
        });
        return {
          size: (t) => [sample(shape.width, t), sample(shape.height, t)],
          update: () => undefined,
        };
      case "ring": {
        const th = shape.thickness ?? 2;
        const glow = shape.glow ?? 18;
        S(el, {
          border: `${px(th)} solid ${shape.color}`,
          "border-radius": px(shape.radius ?? 10),
          "box-shadow": `0 0 ${px(glow)} ${px(glow / 4)} ${shape.color}, inset 0 0 ${px(glow / 2)} ${shape.color}`,
        });
        return {
          size: (t) => [sample(shape.width, t), sample(shape.height, t)],
          update: () => undefined,
        };
      }
      case "spotlight": {
        const hole = h("div", el);
        const f = shape.feather ?? 16;
        const color = shape.color ?? "rgba(0,0,0,0.62)";
        S(hole, {
          position: "absolute",
          "border-radius": px((shape.radius ?? 14) + f * 0.6),
          "box-shadow": `0 0 0 6000px ${color}, inset 0 0 ${px(f)} ${px(f / 3)} ${color}`,
        });
        return {
          size: () => [0, 0],
          update: (t) => {
            // The feather is an inset shadow: grow the hole so it falls mostly outside the rect.
            const g = f * 0.6;
            const [x, y, w, hh] = sample(shape.hole, t);
            S(hole, {
              left: px(x - g),
              top: px(y - g),
              width: px(w + 2 * g),
              height: px(hh + 2 * g),
            });
          },
        };
      }
      case "sweep": {
        S(el, { overflow: "hidden", "border-radius": px(shape.radius ?? 0) });
        const band = shape.band ?? 220;
        const angle = shape.angle ?? 18;
        const bandEl = h("div", el);
        const color = shape.color ?? "rgba(255,255,255,0.22)";
        const tall = shape.height * 2 + band;
        S(bandEl, {
          position: "absolute",
          top: px(-(tall - shape.height) / 2),
          width: px(band),
          height: px(tall),
          background: `linear-gradient(90deg,transparent,${color} 50%,transparent)`,
        });
        const slant =
          Math.abs(Math.tan((angle * Math.PI) / 180)) * shape.height;
        return {
          size: () => [shape.width, shape.height],
          update: (t) => {
            const x = lerp(
              -band - slant,
              shape.width + slant,
              sample(shape.progress, t),
            );
            S(bandEl, {
              transform: `translateX(${px(x)}) rotate(${round(angle)}deg)`,
            });
          },
        };
      }
      case "cursor": {
        el.classList.add("cursor");
        const size = shape.size ?? 28;
        const ringD = size * 1.9;
        const ring = h("div", el, "ring");
        S(ring, {
          width: px(ringD),
          height: px(ringD),
          border: `${px(2.5)} solid ${shape.ringColor ?? "rgba(255,255,255,0.9)"}`,
          "box-shadow": `0 0 14px ${shape.ringColor ?? "rgba(255,255,255,0.6)"}`,
        });
        const arrow = h("div", el);
        arrow.innerHTML = CURSOR_SVG(size);
        const svg = arrow.firstElementChild as unknown as El;
        // The path's tip is at (5, 2.5) of the 24-unit box: that is the hotspot.
        const hx = (5 / 24) * size;
        const hy = (2.5 / 24) * size;
        S(svg, { "transform-origin": `${px(hx)} ${px(hy)}` });
        const clicks = shape.clicks ?? [];
        return {
          size: () => [0, 0],
          update: (t) => {
            let press = 0;
            let ringT = -1;
            for (const k of clicks) {
              if (t >= k - 0.08 && t < k + 0.6) {
                const pr =
                  t < k ? (t - (k - 0.08)) / 0.08 : 1 - clamp((t - k) / 0.18);
                press = Math.max(press, ease("inOutSine", clamp(pr)));
                if (t >= k) ringT = t - k;
              }
            }
            S(svg, {
              transform: `translate(${px(-hx)},${px(-hy)}) scale(${round(1 - 0.14 * press)})`,
            });
            const ru = ringT >= 0 ? ease("outCubic", clamp(ringT / 0.5)) : 0;
            S(ring, {
              transform: `translate(${px(-ringD / 2)},${px(-ringD / 2)}) scale(${round(lerp(0.25, 1.4, ru))})`,
              opacity: round(ringT >= 0 ? 0.9 * (1 - ru) : 0),
            });
          },
        };
      }
    }
  };

  const build = (layer: Layer, parentEl: El, parent: Node | null): Node => {
    const el = h("div", parentEl, "L");
    if (layer.id) el.dataset.id = layer.id;
    const base: LayerBase = layer;
    if (base.radius !== undefined)
      S(el, { "border-radius": px(base.radius), overflow: "hidden" });
    if (base.shadow) S(el, { "box-shadow": base.shadow });
    if (base.blend) S(el, { "mix-blend-mode": base.blend });
    if (base.style) S(el, base.style);

    let size: (t: number) => Vec2 = () => [0, 0];
    let update: (t: number) => void = () => undefined;
    const children: Node[] = [];
    const node: Node = {
      layer,
      el,
      parent,
      size: (t) => size(t),
      update: (t) => update(t),
      children,
    };

    switch (layer.kind) {
      case "image": {
        const s = still(layer.still);
        S(el, { overflow: "hidden" });
        const i = img(el, s.file, s.width, s.height);
        if (layer.crop === undefined) {
          size = () => [s.width, s.height];
        } else {
          const crop = layer.crop;
          size = (t) => {
            const c = sample(crop, t);
            return [c[2], c[3]];
          };
          update = (t) => {
            const c = sample(crop, t);
            S(i, { transform: `translate(${px(-c[0])},${px(-c[1])})` });
          };
        }
        break;
      }
      case "sequence": {
        const seq = manifest.sequences[layer.sequence];
        if (!seq)
          throw new Error(
            `film: the manifest has no sequence "${layer.sequence}"`,
          );
        S(el, { overflow: "hidden" });
        // One <img> whose source follows the frame: a recorded session has
        // hundreds of full-resolution frames, far too many to hold decoded.
        // renderAt waits for the frame's decode before the screenshot.
        const frameImg = img(
          el,
          seq.frames[0] as string,
          seq.clip.width,
          seq.clip.height,
        );
        let shown = 0;
        size = () => [seq.clip.width, seq.clip.height];
        update = (t) => {
          let f: number;
          if (layer.frame !== undefined) f = sample(layer.frame, t);
          else if (seq.fps !== undefined)
            f = (t - (layer.playFrom ?? layer.start ?? 0)) * seq.fps;
          else
            throw new Error(
              `film: sequence layer "${layer.sequence}" is stepped (no fps) and needs a frame track`,
            );
          const idx = Math.max(
            0,
            Math.min(seq.frames.length - 1, Math.floor(f + 1e-6)),
          );
          if (idx === shown) return;
          shown = idx;
          frameImg.src =
            ASSET_PREFIX + encodeURIComponent(seq.frames[idx] as string);
          decoding.push(
            frameImg.decode().catch((err: unknown) => {
              throw new Error(
                `film: frame ${frameImg.src} failed to decode: ${String(err)}`,
              );
            }),
          );
        };
        break;
      }
      case "strip": {
        const st = manifest.strips[layer.strip];
        if (!st)
          throw new Error(`film: the manifest has no strip "${layer.strip}"`);
        let w = 0;
        st.tiles.forEach((name, k) => {
          const s = still(name);
          w = Math.max(w, s.width);
          const i = img(el, s.file, s.width, s.height);
          S(i, { top: px(st.tops[k] ?? 0) });
        });
        size = () => [w, st.height];
        break;
      }
      case "text": {
        update = buildText(layer, el);
        size = () => [el.offsetWidth, el.offsetHeight];
        break;
      }
      case "shape": {
        const sh = buildShape(layer.shape, el);
        size = sh.size;
        update = sh.update;
        break;
      }
      case "html": {
        el.innerHTML = layer.html;
        size = () => [layer.width, layer.height];
        const vars = layer.vars ?? {};
        update = (t) => {
          for (const k in vars)
            el.style.setProperty(`--${k}`, round(sample(vars[k] as Track, t)));
        };
        break;
      }
      case "group": {
        const g: GroupLayer = layer;
        size = () => [g.width ?? 0, g.height ?? 0];
        if (g.perspective !== undefined) {
          S(el, {
            perspective: px(g.perspective),
            "perspective-origin": `${px((g.width ?? 0) / 2)} ${px((g.height ?? 0) / 2)}`,
            "transform-style": "preserve-3d",
          });
        }
        for (const c of g.children) children.push(build(c, el, node));
        break;
      }
    }
    if (layer.id) {
      if (byId.has(layer.id))
        throw new Error(`film: two layers have id "${layer.id}"`);
      byId.set(layer.id, node);
    }
    return node;
  };

  const roots = comp.layers.map((l) => build(l, world, null));
  const overlays = (comp.overlay ?? []).map((l) => build(l, overlay, null));
  // Text sizes are measured once, after fonts load (ready()).
  const measured = new Map<Node, Vec2>();

  // --------------------------------------------------------- transforms ----

  const visible = (l: LayerBase, t: number): boolean =>
    (l.start === undefined || t >= l.start) &&
    (l.end === undefined || t < l.end);

  const sizeOf = (n: Node, t: number): Vec2 => measured.get(n) ?? n.size(t);

  /** The layer's CSS transform at t (origin 0 0 in CSS; the origin is folded in). */
  const transformOf = (n: Node, t: number): string => {
    const l: LayerBase = n.layer;
    const [w, hh] = sizeOf(n, t);
    const [ox, oy] = val(l.origin, t, [w / 2, hh / 2] as Vec2);
    const x = val(l.x, t, 0);
    const y = val(l.y, t, 0);
    const z = val(l.z, t, 0);
    const s = val(l.scale, t, 1);
    const rx = val(l.rotateX, t, 0);
    const ry = val(l.rotateY, t, 0);
    const rz = val(l.rotateZ, t, 0);
    return (
      `translate3d(${px(x)},${px(y)},${px(z)}) translate(${px(ox)},${px(oy)}) ` +
      `rotateZ(${round(rz)}deg) rotateY(${round(ry)}deg) rotateX(${round(rx)}deg) scale(${round(s)}) ` +
      `translate(${px(-ox)},${px(-oy)})`
    );
  };

  /** Layer-local → world matrix at t: every ancestor's transform and perspective, composed. */
  const matrixOf = (n: Node, t: number): DOMMatrix => {
    let m = new DOMMatrix(transformOf(n, t));
    for (let p = n.parent; p; p = p.parent) {
      const g = p.layer as GroupLayer;
      if (g.perspective !== undefined) {
        const cx = (g.width ?? 0) / 2;
        const cy = (g.height ?? 0) / 2;
        const persp = new DOMMatrix([
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          -1 / g.perspective,
          0,
          0,
          0,
          1,
        ]);
        m = new DOMMatrix()
          .translate(cx, cy)
          .multiply(persp)
          .translate(-cx, -cy)
          .multiply(m);
      }
      m = new DOMMatrix(transformOf(p, t)).multiply(m);
    }
    return m;
  };

  // ------------------------------------------------------------- camera ----

  interface CamState {
    fx: number;
    fy: number;
    zoom: number;
    tx: number;
    ty: number;
    roll: number;
  }
  const spaceNode = cam.space === undefined ? null : byId.get(cam.space);
  if (cam.space !== undefined && !spaceNode)
    throw new Error(`film: camera space "${cam.space}" names no layer`);
  const camAt = (t: number): CamState => {
    const [lx, ly] = val(cam.focus, t, [W / 2, H / 2] as Vec2);
    const toWorld = (x: number, y: number): Vec2 => {
      if (!spaceNode) return [x, y];
      const p = matrixOf(spaceNode, t).transformPoint(new DOMPoint(x, y, 0, 1));
      return [p.x / p.w, p.y / p.w];
    };
    let [fx, fy] = toWorld(lx, ly);
    const zoom = val(cam.zoom, t, 1);
    if (cam.bounds !== undefined) {
      // The view never leaves the bounds: clamp the focus so the stage-sized
      // window (W/zoom × H/zoom) stays inside them, on every frame — between
      // keys too, where eased focus and zoom would otherwise drift outside.
      const [bx, by, bw, bh] = cam.bounds;
      const [x0, y0] = toWorld(bx, by);
      const [x1, y1] = toWorld(bx + bw, by + bh);
      const clampAxis = (
        axis: "x" | "y",
        f: number,
        lo: number,
        hi: number,
        half: number,
      ): number => {
        // A window larger than the bounds would show past them whatever the
        // focus: a composition error (zoom too low for its bounds), not a frame
        // to render.
        if (hi - lo < 2 * half - 1e-6)
          throw new Error(
            `film: at t=${t.toFixed(3)} the camera (zoom ${zoom.toFixed(3)}) sees ${(2 * half).toFixed(1)} px along ${axis}, more than its ${(hi - lo).toFixed(1)} px bounds`,
          );
        const c = clamp(f, lo + half, hi - half);
        // The loud backstop: the view this frame draws lies inside the bounds.
        if (c - half < lo - 1e-6 || c + half > hi + 1e-6)
          throw new Error(
            `film: at t=${t.toFixed(3)} the camera view [${(c - half).toFixed(2)}, ${(c + half).toFixed(2)}] leaves its bounds [${lo}, ${hi}] along ${axis}`,
          );
        return c;
      };
      fx = clampAxis("x", fx, Math.min(x0, x1), Math.max(x0, x1), W / 2 / zoom);
      fy = clampAxis("y", fy, Math.min(y0, y1), Math.max(y0, y1), H / 2 / zoom);
    }
    return {
      fx,
      fy,
      zoom,
      tx: val(cam.tiltX, t, 0),
      ty: val(cam.tiltY, t, 0),
      roll: val(cam.roll, t, 0),
    };
  };
  const mb: MotionBlur | false = cam.motionBlur ?? {};
  // A camera key eased "step" is a cut: the camera jumps, it does not move.
  const cuts: number[] = [];
  for (const tr of [cam.focus, cam.zoom, cam.tiltX, cam.tiltY, cam.roll]) {
    if (!Array.isArray(tr)) continue;
    for (const k of tr as readonly (readonly [number, unknown, unknown?])[])
      if (Array.isArray(k) && k[2] === "step") cuts.push(k[0]);
  }
  /** Blur px from the camera's screen speed over the last 1/60 s (fps-independent); none across a cut. */
  const motionBlurAt = (t: number, c: CamState): number => {
    if (mb === false) return 0;
    if (cuts.some((k) => k > t - 1 / 60 && k <= t)) return 0;
    const a = camAt(t - 1 / 60);
    const pan = Math.hypot(a.fx - c.fx, a.fy - c.fy) * c.zoom;
    const zoom = Math.abs(Math.log(c.zoom / a.zoom)) * 700;
    const rot =
      (Math.abs(c.tx - a.tx) +
        Math.abs(c.ty - a.ty) +
        Math.abs(c.roll - a.roll)) *
      8;
    const speed = pan + zoom + rot;
    return Math.min(
      mb.cap ?? 6,
      Math.max(0, speed - (mb.threshold ?? 6)) * (mb.gain ?? 0.06),
    );
  };

  // ------------------------------------------------------------- render ----

  const apply = (n: Node, t: number): void => {
    const l: LayerBase = n.layer;
    if (!visible(l, t)) {
      S(n.el, { display: "none" });
      return;
    }
    const [w, hh] = sizeOf(n, t);
    const opacity = clamp(val(l.opacity, t, 1));
    const blur = val(l.blur, t, 0);
    const styles: Record<string, string> = {
      display: "block",
      transform: transformOf(n, t),
      opacity: round(opacity),
      filter: blur > 0.01 ? `blur(${px(blur)})` : "none",
    };
    if (n.layer.kind !== "text") {
      styles.width = px(w);
      styles.height = px(hh);
    }
    if (l.clipCircle !== undefined) {
      const [r, cx, cy] = sample(l.clipCircle, t);
      styles["clip-path"] =
        `circle(${px(Math.max(0, r))} at ${px(cx)} ${px(cy)})`;
    } else if (l.clipInset !== undefined) {
      const [a, b, c, d] = sample(l.clipInset, t);
      styles["clip-path"] =
        `inset(${px(a)} ${px(b)} ${px(c)} ${px(d)} round ${px(l.clipRadius ?? 0)})`;
    }
    S(n.el, styles);
    if (opacity <= 0) return;
    n.update(t);
    for (const c of n.children) apply(c, t);
  };

  const renderSync = (t: number): void => {
    for (const n of roots) apply(n, t);
    for (const n of overlays) apply(n, t);
    const c = camAt(t);
    const b = motionBlurAt(t, c);
    S(world, {
      transform:
        `translate(${px(W / 2)},${px(H / 2)}) rotateX(${round(c.tx)}deg) rotateY(${round(c.ty)}deg) ` +
        `rotateZ(${round(c.roll)}deg) scale(${round(c.zoom)}) translate(${px(-c.fx)},${px(-c.fy)})`,
      filter: b > 0.05 ? `blur(${px(b)})` : "none",
    });
  };

  const frames = (): Promise<void> =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

  return {
    async ready() {
      await Promise.all(
        imgs.map((i) =>
          i.decode().catch((err: unknown) => {
            throw new Error(
              `film: image ${i.src} failed to decode: ${String(err)}`,
            );
          }),
        ),
      );
      const weights = new Set<number>([400, 600]);
      const walk = (ls: Layer[]): void => {
        for (const l of ls) {
          if (l.kind === "text") weights.add(l.weight ?? 600);
          if (l.kind === "group") walk(l.children);
        }
      };
      walk(comp.layers);
      walk(comp.overlay ?? []);
      for (const wgt of weights)
        await document.fonts.load(`${wgt} 32px "Inter Variable"`);
      await document.fonts.ready;
      if (!document.fonts.check(`600 32px "Inter Variable"`))
        throw new Error("film: Inter Variable did not load");
      // Measure every text box once, laid out (display:block), fonts loaded.
      const measure = (ns: Node[]): void => {
        for (const n of ns) {
          if (n.layer.kind === "text") {
            S(n.el, { display: "block" });
            measured.set(n, [n.el.offsetWidth, n.el.offsetHeight]);
          }
          measure(n.children);
        }
      };
      measure(roots);
      measure(overlays);
    },
    async renderAt(t: number) {
      renderSync(t);
      const pending = decoding;
      decoding = [];
      await Promise.all(pending);
      await frames();
    },
  };
}
