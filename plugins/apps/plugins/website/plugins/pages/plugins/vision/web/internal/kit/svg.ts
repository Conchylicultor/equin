/**
 * SVG as markup strings — a frame's drawing is one string rendered once, then
 * only re-attributed — plus `svgEl` for the few nodes built at runtime.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

/** `class` defaults to `z-line`; `ex` is raw extra attributes. */
export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  c?: string,
  rx?: number,
  ex?: string,
): string {
  return `<rect class="${c || "z-line"}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx || 0}" ${ex || ""}/>`;
}

export function circ(
  x: number,
  y: number,
  r: number,
  c?: string,
  ex?: string,
): string {
  return `<circle class="${c || "z-line"}" cx="${x}" cy="${y}" r="${r}" ${ex || ""}/>`;
}

export function text(
  x: number,
  y: number,
  s: string,
  c?: string,
  anchor?: "start" | "middle" | "end",
  size?: number,
  ex?: string,
): string {
  return `<text class="${c || "z-txt"}" x="${x}" y="${y}" text-anchor="${anchor || "start"}" font-size="${size || 22}" ${ex || ""}>${s}</text>`;
}

/** A group, optionally transformed. */
export function g(inner: string, tr?: string, ex?: string): string {
  return `<g${tr ? ` transform="${tr}"` : ""} ${ex || ""}>${inner}</g>`;
}

/** A live SVG node: attributes set, and optional inner markup. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number>,
  html?: string,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {}))
    e.setAttribute(k, String(v));
  if (html) e.innerHTML = html;
  return e;
}

/** Every element of `root` matching `sel`, typed. Throws when there is none — a drawing that lost a part is a bug. */
export function all<E extends Element>(root: ParentNode, sel: string): E[] {
  const list = [...root.querySelectorAll<E>(sel)];
  if (!list.length) throw new Error(`[vision] no ${sel} in the drawing`);
  return list;
}

/** The one element of `root` matching `sel`. Throws when it is missing. */
export function one<E extends Element>(root: ParentNode, sel: string): E {
  const el = root.querySelector<E>(sel);
  if (!el) throw new Error(`[vision] no ${sel} in the drawing`);
  return el;
}

/**
 * Set an attribute only when its value changes. A drawing re-poses every frame,
 * and most of its parts hold still most of the time: an unchanged write is
 * still a DOM mutation (the render-loop detector reports it as a no-op loop).
 */
export function setAttr(
  el: Element,
  name: string,
  value: string | number,
): void {
  const v = String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}
