import { parse, type DefaultTreeAdapterTypes } from "parse5";

// HTML → the page's STRUCTURE, reduced to what an extractor can use.
//
// The sibling of `page-text.ts`, and the reason both exist: the fingerprint
// wants the most stable, cheapest possible reading of the page (plain text),
// while the model wants to know which title, date and venue belong to the SAME
// event — which is a question only the element tree can answer. Flattening to
// text answers it with adjacency and nothing else, so a two-column layout or a
// table row becomes an ambiguous run of lines.
//
// Pure with respect to the network: a string in, a string out.

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/**
 * Dropped WHOLESALE (element + subtree). Chrome, code, and controls: none of it
 * is an event, and every byte of it is a token the extraction pays for.
 *
 * `form`/`button`/`input` go too — the prompt already tells the model to ignore
 * newsletter signups and booking widgets, and dropping them is cheaper and more
 * reliable than asking.
 */
const DROPPED = new Set([
  "script", "style", "noscript", "template", "nav", "footer", "svg", "math",
  "iframe", "head", "link", "meta", "form", "button", "input", "select",
  "textarea", "picture", "source", "audio", "video", "canvas", "map",
]);

/**
 * Replaced by their children. Inline typography carries no grouping — a
 * `<span>` around half a title only splits it — so unwrapping shortens the
 * markup AND keeps a title in one piece.
 *
 * `html`/`body` are document scaffolding the parser always synthesizes — there
 * is exactly one of each and neither says anything, so they are pure overhead.
 * `wow-image` is Wix's image wrapper; harmless to unwrap, and it appears around
 * every single image on a Wix site.
 */
const UNWRAPPED = new Set([
  "html", "body", "span", "b", "i", "em", "strong", "font", "small", "u", "s",
  "label", "center", "abbr", "wbr", "nobr", "big", "tt", "wow-image",
]);

/**
 * Elements whose ONLY job is grouping, and which may therefore be collapsed
 * away when they group exactly one thing.
 *
 * `li`, `tr`, `td`, `h1`…`h6`, `a` are deliberately absent: those ARE the
 * signal. An `<li>` is precisely "one card" on a listing page, which is the
 * boundary flat text loses.
 */
const GENERIC = new Set([
  "div", "section", "article", "main", "aside", "header", "figure", "hgroup",
]);

/**
 * Attributes kept. Everything else — `class`, `id`, `style`, `data-*`, ARIA —
 * is either presentation or per-request churn, and none of it names an event.
 *
 * `datetime` is the prize: `<time datetime="2026-08-25T22:00:00+02:00">` is an
 * exact instant, where the prose beside it says "mar. 25 août" with no year.
 */
const KEPT_ATTRS = new Set([
  "href", "src", "datetime", "itemprop", "itemtype", "content", "alt", "title",
]);

/** No end tag, and no children — serialized as `<img …>`, never `<img></img>`. */
const VOID_TAGS = new Set(["img", "br", "hr", "col", "area", "embed", "track"]);

interface Attr {
  name: string;
  value: string;
}

/**
 * Our own output tree rather than parse5's.
 *
 * parse5 parses (which is the hard part — real pages omit `</li>` and `</p>`,
 * and only a spec tree builder puts them back); it does not have to be the
 * thing we hand back. Owning the output node type means owning the serializer,
 * which is how `<img>` stays `<img>` instead of parse5's `<img></img>`.
 */
interface SimpleText {
  kind: "text";
  value: string;
}

interface SimpleElement {
  kind: "element";
  tag: string;
  attrs: Attr[];
  children: SimpleNode[];
}

type SimpleNode = SimpleText | SimpleElement;

const isElement = (node: Node): node is Element =>
  "tagName" in node && typeof node.tagName === "string";

function childrenOf(node: Node): Node[] {
  return "childNodes" in node && node.childNodes ? node.childNodes : [];
}

/**
 * One parse5 node → zero or more output nodes.
 *
 * Zero is the common case and the point: a dropped subtree, a whitespace-only
 * text node, and Wix's thousands of empty spacer `<div>`s all reduce to nothing,
 * which is most of the 1.25 MB → 4 KB.
 */
function reduce(node: Node): SimpleNode[] {
  if (node.nodeName === "#comment" || node.nodeName === "#documentType") return [];

  if (node.nodeName === "#text") {
    // parse5 decodes character references for us, so unlike the text path there
    // is no second decode to get wrong here.
    const value = ("value" in node ? node.value : "").replace(/\s+/g, " ");
    return value.trim() ? [{ kind: "text", value }] : [];
  }

  if (!isElement(node)) return childrenOf(node).flatMap(reduce);

  const tag = node.tagName;
  if (DROPPED.has(tag)) return [];

  const children = childrenOf(node).flatMap(reduce);
  if (UNWRAPPED.has(tag)) return children;

  const attrs = node.attrs
    .filter((a) => KEPT_ATTRS.has(a.name) && a.value.trim().length > 0)
    .map((a) => ({ name: a.name, value: a.value.trim() }));

  // An element with no text, no children and nothing kept says nothing.
  if (children.length === 0 && attrs.length === 0 && !VOID_TAGS.has(tag)) return [];

  return [{ kind: "element", tag, attrs, children }];
}

/**
 * Drop an image identical to the one just before it.
 *
 * Responsive CMS templates (Wix here) emit the same `<img>` two or three times
 * for art direction. Once `class`/`srcset`/`sizes` are gone they are literally
 * the same node, and repeating a 200-character CDN URL teaches the model
 * nothing.
 *
 * Runs AFTER `collapse`, not during `reduce`: the copies are each wrapped in
 * their own `<div>`, so they only BECOME siblings once those wrappers are gone.
 * Deduping earlier sees `[div, div]` and finds nothing.
 */
function dedupeImages(nodes: SimpleNode[]): SimpleNode[] {
  return nodes.filter((node, i) => {
    if (node.kind !== "element" || node.tag !== "img" || i === 0) return true;
    const prev = nodes[i - 1];
    if (prev?.kind !== "element" || prev.tag !== "img") return true;
    return serializeAttrs(prev.attrs) !== serializeAttrs(node.attrs);
  });
}

/**
 * Collapse a chain of generic wrappers around a single child.
 *
 * `<div><div><div><h2>X</h2></div></div></div>` → `<h2>X</h2>`. A wrapper that
 * groups exactly one element groups nothing, and CMS output is mostly these.
 *
 * Guarded three ways so it can only ever remove noise: the element must be
 * GENERIC (never an `<li>`, `<a>`, heading or table cell), must carry no kept
 * attribute (an `itemprop` wrapper is meaningful), and must have exactly one
 * child which is itself an element — a wrapper around bare text is what puts
 * that text on its own line, so it stays.
 */
function collapse(node: SimpleNode): SimpleNode {
  if (node.kind !== "element") return node;

  // Bottom-up: settle the children FIRST, so "has exactly one child" is asked of
  // the final shape. Deduping two wrapped copies of an image leaves one child
  // behind, and that wrapper is then collapsible in the same pass.
  let current: SimpleElement = {
    ...node,
    children: dedupeImages(node.children.map(collapse)),
  };

  for (;;) {
    const only: SimpleNode | undefined = current.children[0];
    if (only === undefined || only.kind !== "element") break;
    const collapsible =
      GENERIC.has(current.tag) &&
      current.attrs.length === 0 &&
      current.children.length === 1;
    if (!collapsible) break;
    current = only;
  }

  return current;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeAttrs(attrs: Attr[]): string {
  return attrs
    .map((a) => ` ${a.name}="${a.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join("");
}

function serializeNodes(nodes: SimpleNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return escapeText(node.value);
      const open = `<${node.tag}${serializeAttrs(node.attrs)}>`;
      if (VOID_TAGS.has(node.tag)) return open;
      return `${open}${serializeNodes(node.children)}</${node.tag}>`;
    })
    .join("");
}

/**
 * The page as simplified HTML: structure and text, nothing else.
 *
 * Not streamed, unlike the text path — collapsing a wrapper requires knowing how
 * many children it has, which a token-stream rewriter (`HTMLRewriter`) cannot
 * answer. That is also why parse5 rather than `HTMLRewriter.onEndTag`: real
 * pages omit `</li>` and `</p>`, and only a spec-compliant tree builder infers
 * where they close. Bounding the caller's byte read is what keeps the tree's
 * memory bounded.
 */
export function simplifyPageHtml(html: string): string {
  return serializeNodes(dedupeImages(reduce(parse(html)).map(collapse)));
}
