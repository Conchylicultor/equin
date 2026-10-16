/**
 * A pin's look as DATA: a standalone SVG image placed on its point. The map
 * draws every pin at rest from its mark — on one canvas, as a cached sprite —
 * and the pin's own component draws the SAME mark (`MapMarkImage`) when the
 * pin is lifted into the DOM (hovered, selected), so the two can never drift
 * apart.
 */
import { hash53 } from "@plugins/packages/plugins/string-hash/core";

/** Text the map draws with a mark — never part of the SVG (an SVG drawn as an image has no web fonts). */
export type MapMarkText =
  /** Beside the mark at its `labelAt`, in map-label paint (haloed in the tile colour). */
  | { at: "beside"; text: string }
  /** In the middle of the mark, in `color` — a cluster's count on its disc. */
  | { at: "center"; text: string; color: string };

export interface MapMark {
  kind: "mark";
  /**
   * The look's identity: equal keys mean identical pixels (the sprite cache's
   * key). Build it from everything the SVG is made of — never from the pin id
   * — so pins that look alike share one sprite.
   */
  key: string;
  /**
   * One standalone `<svg>` document (`markSvg`): concrete colours only (no
   * `var()`), no `<use>` (it would reach for a document that is not there), no
   * `<text>`. Rasterizing a mark that breaks this throws.
   */
  svg: string;
  /** The box, in CSS px. */
  width: number;
  height: number;
  /** The map point's place in the box, in CSS px: the tip of a drop, the middle of a disc. */
  anchor: { x: number; y: number };
  /**
   * Where text beside the mark starts, in its box: the left edge of the line
   * and its vertical middle — just right of the shape (not of the box, which
   * holds the shadow's room too). A spot's count and a `beside` text go here.
   */
  labelAt: { x: number; centerY: number };
  texts?: readonly MapMarkText[];
}

/**
 * Not drawable yet: something the mark is made of (an icon's markup) is still
 * loading. The map draws such a pin once it is ready — never a stand-in.
 */
export interface MapMarkPending {
  kind: "pending";
}

export type MapMarkResult = MapMark | MapMarkPending;

export const MARK_PENDING: MapMarkPending = { kind: "pending" };

/** A whole `<svg>` document of `width` × `height` CSS px around `body`. */
export function markSvg(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

/**
 * An id prefix unique to one mark key, for the `id`s a mark's SVG defines
 * (filters, clip paths). The DOM draws marks inline, so two marks defining the
 * same `id` would paint with each other's definitions.
 */
export function markIdPrefix(key: string): string {
  return `mk${hash53(key).toString(36)}`;
}

/** Escape text for an SVG attribute or text node. */
export function escapeSvg(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * What a mark's SVG may not contain, and why — checked where it is rasterized
 * and where the DOM draws it, so a mark that would paint differently on the
 * canvas and in the DOM is refused in both.
 */
export function markSvgProblem(svg: string): string | null {
  if (svg.includes("var(")) return "a CSS variable (resolve it to a colour)";
  if (/<use[\s>]/.test(svg)) return "a <use> (inline the referenced markup)";
  if (/<text[\s>]/.test(svg)) return "a <text> (use MapMark.texts)";
  if (/<script[\s>]|\son[a-z]+=/i.test(svg)) return "script";
  return null;
}

/**
 * Room a mark keeps around its shape for {@link markShadow} to fall in, px —
 * an SVG drawn as an image clips at its box, so a shadow needs the room inside.
 */
export const MARK_SHADOW_PAD = { x: 6, top: 4, bottom: 8 } as const;

/**
 * A `<filter>` drawing Tailwind's `shadow-md` (two soft drops, 10 % black)
 * under whatever it is applied to — define it once in a mark's SVG and set
 * `filter="url(#<id>)"` on the shape.
 */
export function markShadow(id: string): string {
  return (
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feDropShadow dx="0" dy="4" stdDeviation="2.5" flood-color="#000" flood-opacity="0.1"/>` +
    `<feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="#000" flood-opacity="0.1"/>` +
    `</filter>`
  );
}
