import {
  IDENTITY,
  apply,
  multiply,
  parseTransform,
  shapeRings,
  type BBoxElement,
  type Matrix,
  type Subpath,
} from "./glyph-geometry";

/*
 * The active form of a line glyph, derived from its drawing — what `<Icon
 * active>` draws in a family with no fill axis (an app-drawn family, Lucide),
 * the way Material's filled style draws it: every OUTER closed shape filled,
 * and what lies inside it — the check in a circle, a page's text lines, a
 * bot's eyes, a nested shape's outline — cut out of the fill at its own
 * stroke, so the detail survives as a gap. A stroke outside every fill still
 * draws as a line.
 *
 * Two masks do it (SVG has no boolean geometry):
 *
 *   - `<prefix>-k` — everything but the cut-out parts: the filled shapes are
 *     drawn through it, so the inner strokes become gaps;
 *   - `<prefix>-o` — everything but the filled shapes: the other parts are
 *     drawn through it, so they show only outside the fill.
 *
 * Mask ids must be unique in the document the form is drawn in, so the form is
 * written with {@link ACTIVE_ID_TOKEN} and placed (`placeActiveIds`) by
 * whoever puts it in the page: the sheet under its symbol id, an inline
 * `<Icon>` under an id of its own. A mask under `display: none` is not
 * rendered, so the sheets holding these forms are zero-size, not hidden.
 *
 * Each part keeps its place in the tree — its ancestors (`<g>`s carrying a
 * transform, a paint, a motion) are copied around it — so a moving part's
 * fill and its cut-out move together.
 */

/**
 * The derivation's version: folded into the hash of every sprite holding a
 * derived form (the Lucide active sprite), so a cached one is never served
 * once this file draws differently. Bump it with any change to the output.
 */
export const ACTIVE_FORM_VERSION =
  "1: outer closed shapes filled, inner cut out";

/** The token an active form's mask ids are written with; see {@link placeActiveIds}. */
export const ACTIVE_ID_TOKEN = "%active-id%";

/** Write a derived active form's mask ids under `prefix` (unique in its document). */
export function placeActiveIds(markup: string, prefix: string): string {
  return markup.replaceAll(ACTIVE_ID_TOKEN, prefix);
}

interface Node {
  tag: string;
  /** Attributes in source order (a `Map` keeps it). */
  attrs: Map<string, string>;
  children: Node[];
  parent: Node | undefined;
}

const TAG_RE =
  /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const SHAPES = new Set([
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
]);

/** A glyph body as a tree: shape elements and `<g>`s only (anything else throws). */
function parseBody(body: string): Node {
  const root: Node = {
    tag: "g",
    attrs: new Map(),
    children: [],
    parent: undefined,
  };
  let at = root;
  let last = 0;
  for (const hit of body.matchAll(TAG_RE)) {
    if (body.slice(last, hit.index).trim() !== "") {
      throw new Error(
        `[icons] text in a glyph body: "${body.slice(last, hit.index)}"`,
      );
    }
    last = hit.index + hit[0].length;
    const [, close, tag, attrSrc, selfClose] = hit;
    if (tag !== "g" && !SHAPES.has(tag!)) {
      throw new Error(`[icons] <${tag}> in a glyph body`);
    }
    if (close === "/") {
      if (at.tag !== tag || at.parent === undefined) {
        throw new Error(`[icons] unbalanced </${tag}> in a glyph body`);
      }
      at = at.parent;
      continue;
    }
    const attrs = new Map<string, string>();
    for (const [, name, dq, sq] of attrSrc!.matchAll(ATTR_RE)) {
      attrs.set(name!, dq ?? sq ?? "");
    }
    const node: Node = { tag: tag!, attrs, children: [], parent: at };
    at.children.push(node);
    if (selfClose !== "/") at = node;
  }
  if (body.slice(last).trim() !== "" || at !== root) {
    throw new Error(`[icons] malformed glyph body`);
  }
  return root;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function openTag(tag: string, attrs: ReadonlyMap<string, string>): string {
  let out = `<${tag}`;
  for (const [k, v] of attrs) out += ` ${k}="${escapeAttr(v)}"`;
  return out;
}

/** `shape` with `paint` set on it, inside copies of its ancestors up to the body's root. */
function placed(shape: Node, paint: Record<string, string>): string {
  const attrs = new Map(shape.attrs);
  attrs.delete("id");
  for (const [k, v] of Object.entries(paint)) attrs.set(k, v);
  let out = `${openTag(shape.tag, attrs)}/>`;
  for (let p = shape.parent; p?.parent !== undefined; p = p.parent) {
    const pa = new Map(p.attrs);
    pa.delete("id");
    out = `${openTag("g", pa)}>${out}</g>`;
  }
  return out;
}

interface Part {
  node: Node;
  rings: Subpath[];
}

/** The shapes of the tree, each with its outlines taken through its ancestors' transforms. */
function partsOf(root: Node): Part[] {
  const out: Part[] = [];
  const visit = (node: Node, m: Matrix) => {
    const t = node.attrs.get("transform");
    const mm = t === undefined ? m : multiply(m, parseTransform(t));
    if (node.tag === "g") {
      for (const child of node.children) visit(child, mm);
      return;
    }
    const el: BBoxElement = { tag: node.tag, attrs: node.attrs, children: [] };
    const rings = shapeRings(el).map((ring) => ({
      closed: ring.closed,
      points: ring.points.map(([x, y]) => apply(mm, x, y)),
    }));
    out.push({ node, rings });
  };
  visit(root, IDENTITY);
  return out;
}

function area(points: readonly [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Below this (in square grid units), filling a ring paints nothing to see. */
const NO_AREA = 0.05;

/**
 * A shape worth filling: it draws an outline (not a dot or a fill of its
 * own), at least one of its rings is closed, and every open ring is a straight
 * stroke (filling it, which closes it, adds nothing) — so Lucide's pin, a
 * closed head plus an open needle, fills, while an open curve does not.
 */
function fillable(part: Part): boolean {
  const fill = part.node.attrs.get("fill");
  if (fill !== undefined && fill !== "none") return false;
  if (!part.rings.some((r) => r.closed)) return false;
  return part.rings.every((r) => r.closed || area(r.points) < NO_AREA);
}

/** Even-odd point-in-shape over the shape's closed rings. */
function contains(rings: readonly Subpath[], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    if (!ring.closed) continue;
    const pts = ring.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Every point of `inner` lies inside `outer`'s closed rings. */
function inside(inner: Part, outer: Part): boolean {
  return inner.rings.every((ring) =>
    ring.points.every(([x, y]) => contains(outer.rings, x, y)),
  );
}

const MASK_BOX =
  'maskUnits="userSpaceOnUse" x="-12" y="-12" width="48" height="48"';
const MASK_FIELD =
  '<rect x="-12" y="-12" width="48" height="48" fill="white" stroke="none"/>';

/**
 * The derived active form of a glyph body (a body as a family or the Lucide
 * sprite draws it: shapes and `<g>`s, in a 24-unit box), its mask ids written
 * with {@link ACTIVE_ID_TOKEN} — or `undefined` when it has no outer closed
 * shape to fill (a chevron, a plus, a list): it is drawn the same active.
 */
export function deriveActiveForm(body: string): string | undefined {
  const parts = partsOf(parseBody(body));
  const candidates = parts.filter(fillable);
  const filled = candidates.filter(
    (p) => !candidates.some((o) => o !== p && inside(p, o)),
  );
  if (filled.length === 0) return undefined;
  const rest = parts.filter((p) => !filled.includes(p));
  const id = ACTIVE_ID_TOKEN;
  const solid = (p: Part) => {
    const fill = p.node.attrs.get("fill");
    return fill !== undefined && fill !== "none";
  };
  const fills = filled
    .map((p) => placed(p.node, { fill: "currentColor" }))
    .join("");
  if (rest.length === 0) return fills;
  // A part cuts out what it paints: its stroke, and its fill when it has one.
  const cutOut = rest
    .map((p) =>
      placed(p.node, {
        stroke: p.node.attrs.get("stroke") === "none" ? "none" : "black",
        fill: solid(p) ? "black" : "none",
      }),
    )
    .join("");
  const fillArea = filled
    .map((p) => placed(p.node, { stroke: "black", fill: "black" }))
    .join("");
  const others = rest.map((p) => placed(p.node, {})).join("");
  return (
    `<mask id="${id}-k" ${MASK_BOX}>${MASK_FIELD}${cutOut}</mask>` +
    `<mask id="${id}-o" ${MASK_BOX}>${MASK_FIELD}${fillArea}</mask>` +
    `<g mask="url(#${id}-k)">${fills}</g>` +
    `<g mask="url(#${id}-o)">${others}</g>`
  );
}
