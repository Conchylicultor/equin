import type { CardWidth } from "./types";

/**
 * The drawing primitives every card is drawn with: markup strings, so a card's
 * picture is one string rendered once on mount and then only re-attributed.
 * Everything here reads the kit's classes (`kit.css`), never a colour of its
 * own.
 */

/** The drawing's width inside an open card: the card width minus its padding and border and the `.vz` box's. */
export const KIT_WIDTH: Record<CardWidth, number> = { std: 302, wide: 482 };

/** Radii, mirroring `--k-r-sm` / `--k-r` / `--k-r-lg`. */
export const R = { sm: 5, md: 7, lg: 12 } as const;

/** How long (s) a link takes to draw itself, and a token it sends to ride it: mirrors `--k-draw`. */
export const DRAW = 0.55;

const f = (v: number) => +(+v).toFixed(1);

/** Lucide icons (24-unit paths, stroked 2). */
export const LUCIDE = {
  box: `<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>`,
  hammer: `<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>`,
  lightbulb: `<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>`,
  star: `<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  play: `<path d="M6 3 20 12 6 21Z"/>`,
  bell: `<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>`,
  alert: `<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>`,
  terminal: `<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>`,
  code: `<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>`,
  layers: `<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="m2 12 8.58 3.91a2 2 0 0 0 1.66 0L21 12"/><path d="m2 17 8.58 3.91a2 2 0 0 0 1.66 0L21 17"/>`,
  shield: `<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>`,
  bot: `<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
} as const;
export type LucideName = keyof typeof LUCIDE;

/** An arrowhead at (x, y) pointing along `deg`. */
export function head(x: number, y: number, deg: number, s = 6): string {
  const a = (deg * Math.PI) / 180;
  const p = (o: number) =>
    `${f(x - s * Math.cos(a + o))} ${f(y - s * Math.sin(a + o))}`;
  return `M${p(0.5)} L${f(x)} ${f(y)} L${p(-0.5)}`;
}

/**
 * A connector's geometry: a smooth curve leaving (x1,y1) and arriving at
 * (x2,y2) along `dir` (v: vertical, h: horizontal), ending AT the tip: the
 * arrowhead (same stroke, round join) covers the stroke's round cap, so the
 * two meet at any stroke width (a stroke stopped short shows a gap at the thin
 * rest width). The last `lead` (the arrowhead's length) is straight, so the
 * head sits on a straight stroke however steep the bend; it points along it.
 */
export function curve(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  dir: "v" | "h" = "v",
): { d: string; head: string } {
  let d: string;
  let deg: number;
  if (dir === "v") {
    const s = Math.sign(y2 - y1) || 1;
    const lead = Math.min(6, Math.abs(y2 - y1) / 3);
    const m = (y1 + y2 - lead * s) / 2;
    d = `M${f(x1)} ${f(y1)} C ${f(x1)} ${f(m)}, ${f(x2)} ${f(m)}, ${f(x2)} ${f(y2 - lead * s)} L ${f(x2)} ${f(y2)}`;
    deg = s > 0 ? 90 : -90;
  } else {
    const s = Math.sign(x2 - x1) || 1;
    const lead = Math.min(6, Math.abs(x2 - x1) / 3);
    const m = (x1 + x2 - lead * s) / 2;
    d = `M${f(x1)} ${f(y1)} C ${f(m)} ${f(y1)}, ${f(m)} ${f(y2)}, ${f(x2 - lead * s)} ${f(y2)} L ${f(x2)} ${f(y2)}`;
    deg = s > 0 ? 0 : 180;
  }
  return { d, head: head(x2, y2, deg) };
}

const tabbable = (act: string) =>
  act ? ` data-act="${act}" role="button" tabindex="0"` : "";

/** The drawing kit handed to a card's `render`, bound to the card's width. */
export class Kit {
  readonly R = R;
  readonly LUCIDE = LUCIDE;
  readonly curve = curve;
  readonly DRAW = DRAW;
  readonly head = head;

  constructor(readonly w: number) {}

  /** The card's drawing: as wide in units as on screen. */
  svg(h: number, body: string, cls = ""): string {
    return `<svg class="k-svg${cls ? " " + cls : ""}" viewBox="0 0 ${this.w} ${h}">${body}</svg>`;
  }

  text(
    x: number,
    y: number,
    s: string,
    cls = "k-t",
    anchor = "middle",
  ): string {
    return `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" class="${cls}">${s}</text>`;
  }

  /** A plain card; its title (and sub) centred, or top-left with `align: "start"`. */
  box(
    x: number,
    y: number,
    w: number,
    h: number,
    {
      title = "",
      sub = "",
      align = "center",
      r = R.md,
      cls = "",
    }: {
      title?: string;
      sub?: string;
      align?: "center" | "start";
      r?: number;
      cls?: string;
    } = {},
  ): string {
    const s = `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${r}" class="k-box${cls ? " " + cls : ""}"/>`;
    if (!title) return s;
    if (align === "start")
      return (
        s +
        this.text(x + 10, y + 16, title, "k-tl", "start") +
        (sub ? this.text(x + 10, y + 28, sub, "k-ts k-mute", "start") : "")
      );
    return (
      s +
      this.text(x + w / 2, y + h / 2 + (sub ? -1.5 : 4), title, "k-tb") +
      (sub ? this.text(x + w / 2, y + h / 2 + 11, sub, "k-ts k-mute") : "")
    );
  }

  /** THE plugin card: accent outline, its icon and name top-left. */
  plugin(
    x: number,
    y: number,
    w: number,
    h: number,
    {
      title = "Plugin",
      icon = "box",
    }: { title?: string; icon?: LucideName } = {},
  ): string {
    return (
      `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${R.lg}" class="k-plug"/>` +
      this.icon(icon, x + 18, y + 17, 14, "k-ta") +
      this.text(x + 31, y + 21, title, "k-tl k-ta", "start")
    );
  }

  /** A pill; selected (filled) in the states listed in `on`. */
  chip(
    x: number,
    y: number,
    w: number,
    label: string,
    {
      act = "",
      on = "",
      h = 22,
      attrs = "",
    }: { act?: string; on?: string; h?: number; attrs?: string } = {},
  ): string {
    return (
      `<g class="k-chip"${tabbable(act)}${on ? ` data-on="${on}"` : ""} ${attrs}><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${h}" rx="${h / 2}" class="k-box"/>` +
      this.text(x + w / 2, y + h / 2 + 3.5, label, "k-tb") +
      `</g>`
    );
  }

  /** An action control; `label` is a string or `[[states, text], …]`; `busy`: disabled while `ctx.run` plays. */
  button(
    cx: number,
    y: number,
    w: number,
    act: string,
    label: string | readonly (readonly [string, string])[],
    { busy = false }: { busy?: boolean } = {},
  ): string {
    const t = (s: string) => this.text(cx, y + 12.5, s, "k-tb k-ta");
    const labels =
      typeof label === "string"
        ? t(label)
        : label.map(([st, s]) => `<g data-in="${st}">${t(s)}</g>`).join("");
    return `<g class="k-btn"${tabbable(act)}${busy ? " data-busy" : ""}><rect x="${f(cx - w / 2)}" y="${f(y)}" width="${f(w)}" height="18" rx="9"/>${labels}</g>`;
  }

  /**
   * THE connector, and its one motion: whenever it appears or lights it draws
   * itself from its start, its arrowhead arriving with the stroke (`kit.css`).
   * `kind`: uses (ink) | plugs (accent, dashed). It is shown always, or only in
   * the states `in` lists; it rests in its kind's look and is lit (accent,
   * heavier) always (`lit`), in the states `on` lists, or while a
   * `ctx.fire(shot)` carries its token; `fade` dims it while it is not lit.
   * `send`: a token rides the stroke's tip each time it draws. `delay`: s
   * before it draws. `a`, `b`: graph ends for `ctx.highlight` (a highlighted
   * link is lit too).
   */
  link(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    {
      kind = "uses",
      dir = "v",
      in: shown = "",
      on = "",
      lit = false,
      shot = "",
      fade,
      send = false,
      delay = 0,
      a = "",
      b = "",
    }: {
      kind?: "uses" | "plugs";
      dir?: "v" | "h";
      in?: string;
      on?: string;
      lit?: boolean;
      shot?: string;
      fade?: "dim" | "faint";
      send?: boolean;
      delay?: number;
      a?: string;
      b?: string;
    } = {},
  ): string {
    const { d, head: hd } = curve(x1, y1, x2, y2, dir);
    const cls = `k-link k-${kind}${on || lit || shot ? " k-sw" : ""}${lit ? " k-sel" : ""}${fade ? ` k-sw-${fade}` : ""}`;
    const data =
      (shown ? ` data-in="${shown}"` : "") +
      (on ? ` data-on="${on}"` : "") +
      (shot ? ` data-shot="${shot}" data-d="${delay}"` : "") +
      (a ? ` data-a="${a}" data-b="${b}"` : "");
    return (
      `<g class="${cls}"${data}><path d="${d}"/><path d="${d}" pathLength="100" class="k-cover" style="--d:${delay}s"/>` +
      `<path d="${hd}" class="k-in" style="--d:${+(delay + DRAW - 0.05).toFixed(2)}s"/>` +
      (send ? this.token(d, { delay }) : "") +
      `</g>`
    );
  }

  legend(
    x: number,
    y: number,
    items: readonly (readonly ["uses" | "plugs", string])[],
  ): string {
    let s = "";
    let cx = x;
    items.forEach(([kind, label]) => {
      s +=
        `<line x1="${cx}" x2="${cx + 20}" y1="${y}" y2="${y}" class="k-link k-${kind}"/>` +
        this.text(cx + 26, y + 3.5, label, "k-ts", "start");
      cx += 26 + label.length * 5.2 + 18;
    });
    return `<g class="k-legend">${s}</g>`;
  }

  /** A Lucide icon drawn `s` px wide, centred on (cx, cy). */
  icon(name: LucideName, cx: number, cy: number, s = 14, cls = ""): string {
    return `<g transform="translate(${f(cx - s / 2)} ${f(cy - s / 2)}) scale(${f((s / 24) * 1000) / 1000})" class="k-ic${cls ? " " + cls : ""}">${LUCIDE[name]}</g>`;
  }

  /** A few lines of "code": `[indent, width]` bars, never readable. */
  codeLines(
    x: number,
    y: number,
    lines: readonly (readonly [number, number])[],
    gap = 8,
  ): string {
    return lines
      .map(
        ([ind, w], k) =>
          `<line x1="${f(x + ind)}" x2="${f(x + ind + w)}" y1="${f(y + k * gap)}" y2="${f(y + k * gap)}" class="k-code"/>`,
      )
      .join("");
  }

  cylinder(
    x: number,
    y: number,
    w: number,
    label: string,
    { h = 26, dim = false }: { h?: number; dim?: boolean } = {},
  ): string {
    return (
      `<g${dim ? ' class="k-mute"' : ""}><path d="M${f(x)} ${f(y)} v${h} a${f(w / 2)} 6 0 0 0 ${f(w)} 0 v${-h}" class="k-box"/>` +
      `<ellipse cx="${f(x + w / 2)}" cy="${f(y)}" rx="${f(w / 2)}" ry="6" class="k-box"/>` +
      this.text(x + w / 2, y + h * 0.75, label) +
      `</g>`
    );
  }

  /** A mini browser / app window: title bar with three dots and its address, then `body`. */
  window(
    x: number,
    y: number,
    w: number,
    h: number,
    addr: string,
    body = "",
  ): string {
    return (
      `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${R.sm}" class="k-box"/><path d="M${f(x)} ${f(y + 18)} H${f(x + w)}" class="k-ink k-faint"/>` +
      [0, 1, 2]
        .map(
          (k) =>
            `<circle cx="${f(x + 8 + k * 6)}" cy="${f(y + 9)}" r="1.8" class="k-ink"/>`,
        )
        .join("") +
      this.text(x + 30, y + 12.5, addr, "k-ts k-mute", "start") +
      body
    );
  }

  /**
   * A token's single trip along `path`, as long as a link's draw, each time
   * its piece appears or lights (a link sends one with `send`; use this
   * directly only off a link).
   */
  token(path: string, { delay = 0 }: { delay?: number } = {}): string {
    return (
      `<circle r="3.5" class="k-accf" stroke="none" opacity="0">` +
      `<animateMotion begin="indefinite" data-d="${delay}" dur="${DRAW}s" path="${path}"/>` +
      `<set attributeName="opacity" to="1" begin="indefinite" data-d="${delay}" dur="${DRAW}s"/></circle>`
    );
  }

  /** A stream of traffic: a token looping forever along `path`. */
  dot(
    path: string,
    { dur = 1.6, delay = 0 }: { dur?: number; delay?: number } = {},
  ): string {
    return `<circle r="3.5" class="k-accf"><animateMotion dur="${dur}s" begin="${delay}s" repeatCount="indefinite" path="${path}"/></circle>`;
  }

  check(x: number, y: number, s = 1): string {
    return `<path d="M${f(x)} ${f(y)} l${f(3 * s)} ${f(3 * s)} l${f(6 * s)} ${f(-7 * s)}" class="k-acc" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  spinner(cx: number, cy: number, r = 6): string {
    return (
      `<circle cx="${f(cx)}" cy="${f(cy)}" r="${r}" class="k-ink k-faint"/>` +
      `<g class="k-spin"><circle cx="${f(cx)}" cy="${f(cy)}" r="${r}" fill="none"/><path d="M${f(cx)} ${f(cy - r)} a${r} ${r} 0 0 1 ${r} ${r}" class="k-acc"/></g>`
    );
  }

  // ---- HTML ----
  hbtn(
    label: string,
    act: string,
    { on = "", attrs = "" }: { on?: string; attrs?: string } = {},
  ): string {
    return `<span class="k-hbtn"${tabbable(act)}${on ? ` data-on="${on}"` : ""} ${attrs}>${label}</span>`;
  }

  /** options: `[{ v, label, on }]` — on: the states in which that option reads as selected. */
  segmented(
    act: string,
    options: readonly { v: string | number; label: string; on?: string }[],
  ): string {
    return `<span class="k-seg">${options
      .map(
        ({ v, label, on = "" }) =>
          `<span class="k-sg"${tabbable(act)} data-v="${v}"${on ? ` data-on="${on}"` : ""}>${label}</span>`,
      )
      .join("")}</span>`;
  }

  hchip(
    label: string,
    {
      act = "",
      on = "",
      attrs = "",
    }: { act?: string; on?: string; attrs?: string } = {},
  ): string {
    return `<span class="k-hchip"${tabbable(act)}${on ? ` data-on="${on}"` : ""} ${attrs}>${label}</span>`;
  }

  appFrame(title: string, body: string, cls = ""): string {
    return `<span class="k-app${cls ? " " + cls : ""}"><span class="k-app-title">${title}</span><span class="k-app-body">${body}</span></span>`;
  }

  bar(pct: number): string {
    return `<span class="k-bar" style="width:${pct}%"></span>`;
  }
}
