import type { IconifyJSON } from "@iconify/types";
import { paintedBox } from "../core";

/**
 * The Seti file-type glyphs, vendored as an Iconify set.
 *
 * Seti (https://github.com/jesseweed/seti-ui, MIT) is the icon theme VS Code
 * ships as `theme-seti`; VS Code draws it as a one-colour font built from the
 * same `icons/*.svg` this vendors. So each SVG is reduced to ONE colour here
 * too — every paint becomes `currentColor` — and the caller tints it (a file
 * type's tone). The vendoring script (`scripts/vendor-seti.ts`) fetches the
 * pinned commit below, checks the license, runs {@link normalizeSetiSvg} over
 * every icon and writes {@link SETI_JSON_REL_PATH} and
 * {@link SETI_NAMES_REL_PATH}; the `icons:seti-in-sync` check fails when either
 * no longer matches this file.
 */

/** Where the glyphs come from: a pinned commit, never a branch. */
export const SETI_SOURCE = {
  repo: "jesseweed/seti-ui",
  commit: "2d6c5e68b4ded73c92dac291845ee44e1182d511",
  license: "MIT",
} as const;

// Bump when {@link normalizeSetiSvg} changes what it emits, so the in-sync
// check asks for a re-vendor even though the commit did not move.
export const SETI_NORMALIZER_VERSION = 4;

/**
 * The margin a cropped glyph keeps on each side of its square box, as a
 * fraction of the side: the 2-in-24 keyline Material Symbols and Lucide draw
 * inside, so a file glyph paints as much of its icon box as the folder or
 * symbol beside it does — not edge to edge, which reads a size larger.
 */
export const SETI_CROP_MARGIN = 1 / 12;

/** What the vendored set is a function of: the source commit and the normalizer. */
export function setiIdentity(): string {
  return `${SETI_SOURCE.repo}@${SETI_SOURCE.commit}#n${SETI_NORMALIZER_VERSION}`;
}

/** The vendored Iconify JSON (read by the sprite server through the icons server barrel). */
export const SETI_JSON_REL_PATH =
  "plugins/ui/plugins/icons/server/internal/seti/seti.json";

/** The upstream license, copied verbatim beside the JSON. */
export const SETI_LICENSE_REL_PATH =
  "plugins/ui/plugins/icons/server/internal/seti/LICENSE.txt";

/** The `SetiName` union `seti()` accepts. */
export const SETI_NAMES_REL_PATH =
  "plugins/ui/plugins/icons/core/seti-names.generated.ts";

// ── A minimal XML reader, enough for the pinned SVGs ────────────────────────
// The source set is small and fixed (a pinned commit), so this reads exactly
// the constructs it uses and THROWS on anything else: a re-vendor that meets a
// new element or attribute fails loudly instead of emitting a wrong glyph.

interface XmlElement {
  tag: string;
  attrs: Map<string, string>;
  children: XmlElement[];
  text: string;
}

const TOKEN_RE =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseXml(src: string): XmlElement {
  const root: XmlElement = {
    tag: "#root",
    attrs: new Map(),
    children: [],
    text: "",
  };
  const stack = [root];
  let consumed = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    if (m.index !== consumed) {
      throw new Error(`[seti] unparsable SVG at offset ${consumed}`);
    }
    consumed = m.index + m[0].length;
    const [, close, open, attrSrc, selfClose, text] = m;
    const top = stack[stack.length - 1]!;
    if (text !== undefined) {
      top.text += text;
    } else if (close !== undefined) {
      if (top.tag !== close || stack.length === 1) {
        throw new Error(`[seti] mismatched </${close}>`);
      }
      stack.pop();
    } else if (open !== undefined) {
      const attrs = new Map<string, string>();
      for (const a of (attrSrc ?? "").matchAll(ATTR_RE)) {
        attrs.set(a[1]!, a[2] ?? a[3] ?? "");
      }
      const el: XmlElement = { tag: open, attrs, children: [], text: "" };
      top.children.push(el);
      if (selfClose !== "/") stack.push(el);
    }
  }
  if (consumed !== src.length || stack.length !== 1) {
    throw new Error("[seti] truncated SVG");
  }
  const [svg, ...rest] = root.children;
  if (svg?.tag !== "svg" || rest.length > 0) {
    throw new Error("[seti] expected exactly one <svg> root");
  }
  return svg;
}

/** Drawn elements kept as they are (attributes normalized). */
const DRAWN = new Set([
  "path",
  "circle",
  "ellipse",
  "rect",
  "polygon",
  "polyline",
  "line",
  "g",
  "use",
  "defs",
]);
/** Elements that carry only colour or metadata: dropped (a gradient fill becomes currentColor). */
const DROPPED = new Set([
  "style",
  "title",
  "desc",
  "metadata",
  "linearGradient",
  "radialGradient",
  "stop",
]);

/** Geometry and paint-structure attributes kept verbatim. */
const KEPT_ATTRS = new Set([
  "d",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "width",
  "height",
  "points",
  "transform",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "fill-rule",
  "clip-rule",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
]);
/** Attributes with no bearing on a one-colour glyph. */
const DROPPED_ATTRS = new Set([
  "class",
  "style",
  "xmlns",
  "xmlns:xlink",
  "version",
  "baseProfile",
  "preserveAspectRatio",
  "data-name",
  "font-size",
  "font-weight",
  "font-stretch",
  "letter-spacing",
  "word-spacing",
]);
const PAINT_ATTRS = new Set(["fill", "stroke"]);

/** `a:b;c:d` → entries. */
function declarations(css: string): [string, string][] {
  return css
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d !== "")
    .map((d) => {
      const i = d.indexOf(":");
      if (i < 0) throw new Error(`[seti] bad CSS declaration "${d}"`);
      return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
    });
}

/** `.a,.b{fill:#x}` rules of a `<style>` → class → declarations. Only class selectors are supported. */
function classRules(svg: XmlElement): Map<string, [string, string][]> {
  const out = new Map<string, [string, string][]>();
  const visit = (el: XmlElement) => {
    if (el.tag === "style") {
      for (const rule of el.text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        for (const sel of rule[1]!.split(",").map((s) => s.trim())) {
          if (!/^\.[\w-]+$/.test(sel)) {
            throw new Error(`[seti] unsupported CSS selector "${sel}"`);
          }
          const cls = sel.slice(1);
          out.set(cls, [...(out.get(cls) ?? []), ...declarations(rule[2]!)]);
        }
      }
    }
    el.children.forEach(visit);
  };
  visit(svg);
  return out;
}

/** An element's attributes after CSS: presentation attributes, then class rules, then `style=""`. */
function effectiveAttrs(
  el: { readonly attrs: ReadonlyMap<string, string> },
  rules: Map<string, [string, string][]>,
): [string, string][] {
  const merged = new Map(el.attrs);
  for (const cls of (el.attrs.get("class") ?? "").split(/\s+/)) {
    for (const [k, v] of rules.get(cls) ?? []) merged.set(k, v);
  }
  for (const [k, v] of declarations(el.attrs.get("style") ?? "")) {
    merged.set(k, v);
  }
  return [...merged.entries()];
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

/** Rounded to 1/1000 of a unit, so the vendored JSON is stable and short. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000 + 0;
}

/**
 * One glyph's normalized body: every paint `currentColor` (`none` kept),
 * gradients and styles dropped, ids namespaced to the icon (a sprite holds every
 * glyph in one document), and the box CROPPED to what the glyph paints: the
 * smallest square around its painted bounding box (within the source viewBox),
 * centred on it, with a {@link SETI_CROP_MARGIN} margin, its origin moved to
 * 0,0. Seti's own boxes leave wide, uneven margins (a glyph may cover half its
 * box), so cropping is what lets every glyph fill the icon box it is drawn in.
 */
export function normalizeSetiSvg(
  name: string,
  src: string,
): { body: string; width: number; height: number } {
  const svg = parseXml(src);
  const rules = classRules(svg);
  // `seti_` never collides with a glyph's own `seti-<name>` symbol id.
  const idPrefix = `seti_${name}_`;

  // The ids something still points at once gradients are gone.
  const referenced = new Set<string>();
  const collectRefs = (el: XmlElement) => {
    if (DROPPED.has(el.tag)) return;
    for (const [k, v] of effectiveAttrs(el, rules)) {
      if (k === "href" || k === "xlink:href") referenced.add(v.slice(1));
    }
    el.children.forEach(collectRefs);
  };
  collectRefs(svg);

  const attrsOf = (el: XmlElement): string[] => {
    const out: string[] = [];
    for (const [k, v] of effectiveAttrs(el, rules)) {
      if (DROPPED_ATTRS.has(k) || v === "null") continue;
      if (PAINT_ATTRS.has(k)) {
        out.push(`${k}="${v === "none" ? "none" : "currentColor"}"`);
      } else if (k === "id") {
        if (referenced.has(v)) out.push(`id="${idPrefix}${escapeAttr(v)}"`);
      } else if (k === "href" || k === "xlink:href") {
        if (!v.startsWith("#")) {
          throw new Error(`[seti] ${name}: external reference "${v}"`);
        }
        out.push(`href="#${idPrefix}${escapeAttr(v.slice(1))}"`);
      } else if (KEPT_ATTRS.has(k)) {
        if (v.includes("url(")) {
          throw new Error(`[seti] ${name}: paint server in "${k}"`);
        }
        out.push(`${k}="${escapeAttr(v)}"`);
      } else {
        throw new Error(
          `[seti] ${name}: unknown attribute "${k}" on <${el.tag}>`,
        );
      }
    }
    return out;
  };

  const render = (el: XmlElement): string => {
    if (DROPPED.has(el.tag)) return "";
    if (!DRAWN.has(el.tag)) {
      throw new Error(`[seti] ${name}: unknown element <${el.tag}>`);
    }
    if (el.text.trim() !== "") {
      throw new Error(`[seti] ${name}: text content in <${el.tag}>`);
    }
    const attrs = attrsOf(el);
    const head = [el.tag, ...attrs].join(" ");
    const inner = el.children.map(render).join("");
    // A <defs> that only held gradients holds nothing now.
    if (el.tag === "defs" && inner === "") return "";
    return inner === "" ? `<${head}/>` : `<${head}>${inner}</${el.tag}>`;
  };

  // The source box: the viewBox, else width × height.
  const viewBox = svg.attrs.get("viewBox");
  let [minX, minY, width, height] = viewBox
    ? viewBox
        .trim()
        .split(/[\s,]+/)
        .map(Number)
    : [0, 0, Number(svg.attrs.get("width")), Number(svg.attrs.get("height"))];
  if (
    ![minX, minY, width, height].every(
      (n) => n !== undefined && Number.isFinite(n),
    ) ||
    width! <= 0 ||
    height! <= 0
  ) {
    throw new Error(`[seti] ${name}: no usable viewBox or width/height`);
  }
  minX ??= 0;
  minY ??= 0;

  // The root's own presentation attributes (fill-rule, stroke-linejoin, …)
  // move onto a wrapper group, with the crop's origin shift.
  const rootAttrs = attrsOf({
    ...svg,
    attrs: new Map(
      [...svg.attrs].filter(
        ([k]) => !["viewBox", "width", "height", "id"].includes(k),
      ),
    ),
  });
  const inner = svg.children.map(render).join("");
  if (inner === "") throw new Error(`[seti] ${name}: draws nothing`);

  // What the glyph paints, clipped to the source box (as the source renders).
  // Measured after rendering, which rejects what it does not know.
  const painted = paintedBox(svg, (el) => new Map(effectiveAttrs(el, rules)));
  if (painted === undefined) throw new Error(`[seti] ${name}: paints nothing`);
  const x0 = Math.max(painted.minX, minX);
  const y0 = Math.max(painted.minY, minY);
  const x1 = Math.min(painted.maxX, minX + width!);
  const y1 = Math.min(painted.maxY, minY + height!);
  if (x1 <= x0 || y1 <= y0) {
    throw new Error(`[seti] ${name}: paints nothing inside its box`);
  }
  const side = round(Math.max(x1 - x0, y1 - y0) / (1 - 2 * SETI_CROP_MARGIN));
  const originX = round((x0 + x1) / 2 - side / 2);
  const originY = round((y0 + y1) / 2 - side / 2);

  const shift =
    originX !== 0 || originY !== 0
      ? `transform="translate(${round(-originX)} ${round(-originY)})"`
      : undefined;
  const ownTransform = rootAttrs.some((a) => a.startsWith("transform="));
  if (shift !== undefined && !ownTransform) rootAttrs.push(shift);
  let body =
    rootAttrs.length === 0 ? inner : `<g ${rootAttrs.join(" ")}>${inner}</g>`;
  if (shift !== undefined && ownTransform) body = `<g ${shift}>${body}</g>`;
  return { body, width: side, height: side };
}

/** The vendored Iconify JSON for `icons` (name → source SVG). */
export function buildSetiSet(icons: ReadonlyMap<string, string>): IconifyJSON {
  const out: IconifyJSON = {
    prefix: "seti",
    info: {
      name: "Seti UI",
      author: {
        name: "Jesse Weed",
        url: `https://github.com/${SETI_SOURCE.repo}`,
      },
      license: {
        title: "MIT",
        spdx: "MIT",
        url: `https://github.com/${SETI_SOURCE.repo}/blob/${SETI_SOURCE.commit}/LICENSE.md`,
      },
      version: setiIdentity(),
    },
    icons: {},
  };
  for (const name of [...icons.keys()].sort()) {
    out.icons[name] = normalizeSetiSvg(name, icons.get(name)!);
  }
  return out;
}

/** The identity a vendored JSON was built from (its `info.version`). */
export function readSetiIdentity(set: IconifyJSON): string | undefined {
  return set.info?.version;
}

export function renderSetiNames(names: readonly string[]): string {
  return [
    "// AUTO-GENERATED by plugins/ui/plugins/icons/scripts/vendor-seti.ts — do not edit.",
    `// From: ${setiIdentity()} (${SETI_SOURCE.license})`,
    "//",
    "// SetiName: every glyph in the vendored Seti set. The `icons:seti-in-sync`",
    "// check fails when the vendored JSON or this list no longer matches.",
    "",
    `export type SetiName =\n${[...names]
      .sort()
      .map((n) => `  | ${JSON.stringify(n)}`)
      .join("\n")};`,
    "",
  ].join("\n");
}
