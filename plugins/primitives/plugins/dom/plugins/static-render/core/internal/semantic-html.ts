import { Parser } from "htmlparser2";

// ── The semantic filter: rendered app markup → what a robot reads ─────────────
//
// A static render of a pane is the app's real markup: wrappers, classes, icons,
// controls. A search engine needs the document under it — headings, prose,
// lists, links, tables, figures — so this keeps exactly those elements and
// unwraps everything else into its text.
//
// Values are passed through VERBATIM: the parser runs with `decodeEntities:
// false`, so text and attribute values are the input's own escaped source (the
// React serializer's), re-emitted as they came. Nothing is decoded, so nothing
// can be decoded twice or emitted unescaped.

/** Elements kept, with their (filtered) attributes. Everything else is unwrapped. */
const BLOCK = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "figure",
  "figcaption",
]);
const INLINE = new Set(["a", "code", "strong", "em"]);

/** A block element's opening tag, anywhere in an emitted run. */
const BLOCK_TAG = new RegExp(`<(${[...BLOCK].join("|")})[ >]`);

/**
 * Elements dropped with their whole subtree: drawings, code, controls (whose
 * visible text is UI, not content — a control that navigates carries
 * `data-link` and is kept as a link), embedded media and the document head.
 */
const DROPPED = new Set([
  "svg",
  "canvas",
  "script",
  "style",
  "noscript",
  "template",
  "button",
  "input",
  "select",
  "option",
  "optgroup",
  "textarea",
  "datalist",
  "output",
  "progress",
  "meter",
  "iframe",
  "video",
  "audio",
  "object",
  "embed",
  "math",
  "head",
  "title",
  "meta",
  "link",
]);

/**
 * Elements unwrapped WITHOUT a word boundary: text-level markup that sits
 * inside a word or a sentence, whose text runs on into its neighbours'. Any
 * other unwrapped element separates its text from what is beside it — a
 * `span` included: in app markup a span is as often a laid-out box (a card's
 * name above its description) as a run of text, and a stray space costs a
 * robot less than two words glued into one. A span's edge is the one judged
 * by what is written beside it (see `semanticHtml`): where the markup runs a
 * word straight into it (`equin<span>.</span>`, `<span>$</span>5`), the author
 * wrote one run of text, styled in part, and no space is put there.
 */
const PHRASING = new Set([
  "b",
  "i",
  "u",
  "s",
  "small",
  "abbr",
  "mark",
  "sub",
  "sup",
  "wbr",
  "del",
  "ins",
  "dfn",
  "kbd",
  "var",
  "samp",
]);

/**
 * An image source a robot can fetch on its own: an absolute http(s) URL or a
 * root-relative path. Anything else — a `data:` URL (the build inlines every
 * imported asset as one, tens of KB each), a `blob:`, none — is the picture's
 * bytes or nothing, never an address worth serving in every request of the
 * page: such an image is kept as what it says, its alt.
 */
const ADDRESSED_SRC = /^(https?:\/\/|\/(?!\/))/i;

/**
 * Kept elements a `<figure>` may sit in (flow content; `null` is the document
 * root). Inside anything else — a paragraph, a heading, inline markup, a
 * figure (which has its own caption) — an unaddressed image's alt is written
 * as text instead.
 */
const FIGURE_HOSTS = new Set<string | null>([
  null,
  "li",
  "blockquote",
  "td",
  "th",
]);

interface KeptFrame {
  readonly kind: "kept";
  /** `null` for the document root. */
  readonly tag: string | null;
  readonly attrs: string;
  readonly block: boolean;
  readonly pre: boolean;
  /** The element is not an `a` but carried `data-link`: its content is wrapped in one. */
  readonly linkHref: string | undefined;
  readonly isLink: boolean;
  /** A link's `aria-label`: its text when it has none of its own. */
  readonly label: string | undefined;
  /** The `<title>` text of the drawings inside a link: its text after the label. */
  svgTitle: string;
  html: string;
  /** Holds text or an image — an element without either is an empty wrapper. */
  content: boolean;
}

/** An element whose children join the nearest kept element. */
interface UnwrappedFrame {
  readonly kind: "unwrapped";
  /** It separates its text from its neighbours' (a box, not text-level markup). */
  readonly boundary: boolean;
  /**
   * A `span`: its closing edge is a boundary only if what follows is not a
   * word written straight against it (resolved by the next event).
   */
  readonly span: boolean;
}

/** An element dropped with its subtree. */
interface DroppedFrame {
  readonly kind: "dropped";
  readonly tag: string;
  /** Inside a drawing that is not `aria-hidden`: its `<title>` names it. */
  readonly inSvg: boolean;
}

type Frame = KeptFrame | UnwrappedFrame | DroppedFrame;

function attrValue(v: string): string {
  // Verbatim, inside double quotes: a raw `"` (never in React's output) is the
  // one character that would end the value early.
  return v.replaceAll('"', "&quot;");
}

/**
 * Filter rendered HTML down to its semantic document: `h1`–`h6`, `p`,
 * `a[href]`, `ul`/`ol`/`li`, `blockquote`, `pre`/`code`, tables, `figure` /
 * `figcaption`, `img[alt]` (with `src` + `alt`), `strong` / `em`, `br`.
 *
 * - An element carrying `data-link` (link-gesture's static-render mark on a
 *   navigating control) becomes a link: `<a href="…">` around its content — a
 *   kept element keeps its tag with the link inside it. Links never nest.
 * - Every attribute but `href` (links) and `src` / `alt` (images) is dropped;
 *   an `img` without a non-empty `alt` is decoration and goes. An image keeps
 *   `<img src alt>` only when its `src` is an address (http(s) or
 *   root-relative); one whose `src` is a `data:` URL (or absent) is its alt —
 *   `<figure><figcaption>alt</figcaption></figure>` where a figure may stand
 *   (the static media player's shape), the alt as text where it may not
 *   (inside a link, a paragraph, a heading). A link with no
 *   text of its own (an icon) keeps its accessible name as its text: its
 *   `aria-label`, else its drawing's `<title>` (an `img[alt]` inside it is
 *   kept as is).
 * - Drawings, scripts, styles, form controls, media and anything
 *   `aria-hidden="true"` go with their subtree. Content under `hidden` stays
 *   (a closed fold's text is content; the static render writes it there).
 * - Every other element is unwrapped into its children; a kept element left
 *   with no text and no image is dropped. A box separates its text from its
 *   neighbours' by a space; a `span` does not where a word is written straight
 *   against its edge (`equin<span>.</span>` reads `equin.`).
 * - Text and inline elements left at the top level, between blocks, are
 *   wrapped in a `<p>` (a run holding a block — a link around a card — stays
 *   as it is): a document's prose is in paragraphs.
 * - Whitespace collapses to single spaces (verbatim inside `pre`); each block
 *   element ends its line.
 */
export function semanticHtml(html: string): string {
  const root: KeptFrame = {
    kind: "kept",
    tag: null,
    attrs: "",
    block: true,
    pre: false,
    linkHref: undefined,
    isLink: false,
    label: undefined,
    svgTitle: "",
    html: "",
    content: false,
  };
  const stack: Frame[] = [root];
  let dropDepth = 0;
  let linkDepth = 0;
  // Where the top level's current inline run starts in `root.html`.
  let runStart = 0;
  // The last event was text ending in a word character (no space after it).
  let wordBefore = false;
  // A span just closed: its boundary waits for what follows.
  let spanEdge = false;

  const keptParent = (): KeptFrame => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]!;
      if (f.kind === "kept") return f;
    }
    return root;
  };

  /** Append text (collapsed outside `pre`) to the nearest kept element. */
  const appendText = (text: string): void => {
    const f = keptParent();
    if (f.pre) {
      f.html += text;
      if (/\S/.test(text)) f.content = true;
      return;
    }
    let t = text.replace(/\s+/g, " ");
    if (f.html === "" || /[ \n]$/.test(f.html)) t = t.replace(/^ /, "");
    if (t === "") return;
    f.html += t;
    if (/\S/.test(t)) f.content = true;
  };

  const appendBoundary = (): void => {
    const f = keptParent();
    if (f.pre) return;
    appendText(" ");
  };

  /** A closed span's edge, now that what follows it is known: a boundary. */
  const settleSpanEdge = (): void => {
    if (!spanEdge) return;
    spanEdge = false;
    appendBoundary();
  };

  /** The top level's inline run since the last block, as a paragraph. */
  const flushRun = (): void => {
    const head = root.html.slice(0, runStart);
    const run = root.html
      .slice(runStart)
      .trim()
      .replace(/^(<br>)+|(<br>)+$/g, "")
      .trim();
    if (run === "") root.html = head;
    else if (BLOCK_TAG.test(run)) root.html = `${head}${run}\n`;
    else root.html = `${head}<p>${run}</p>\n`;
    runStart = root.html.length;
  };

  /** Append a finished block element to `parent`, on a line of its own. */
  const appendBlock = (parent: KeptFrame, element: string): void => {
    if (parent === root) flushRun();
    parent.html = parent.html.replace(/ $/, "") + element + "\n";
    if (parent === root) runStart = root.html.length;
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        settleSpanEdge();
        const glued = wordBefore;
        wordBefore = false;
        if (dropDepth > 0) {
          dropDepth++;
          const up = stack.at(-1);
          stack.push({
            kind: "dropped",
            tag: name,
            inSvg:
              up?.kind === "dropped" &&
              up.inSvg &&
              attribs["aria-hidden"] !== "true",
          });
          return;
        }
        const dataLink = attribs["data-link"];
        const destination =
          dataLink ?? (name === "a" ? attribs["href"] : undefined);
        // A link opens only outside another one: links never nest (a
        // navigating control inside a link is unwrapped into it).
        const link = linkDepth > 0 ? undefined : destination;
        if (
          attribs["aria-hidden"] === "true" ||
          (DROPPED.has(name) && destination === undefined)
        ) {
          dropDepth = 1;
          stack.push({
            kind: "dropped",
            tag: name,
            inSvg: name === "svg" && attribs["aria-hidden"] !== "true",
          });
          return;
        }
        if (name === "img") {
          const alt = attribs["alt"]?.replace(/\s+/g, " ").trim() ?? "";
          const src = attribs["src"];
          const f = keptParent();
          if (alt === "") {
            // Decoration.
          } else if (src !== undefined && ADDRESSED_SRC.test(src)) {
            f.html += `<img src="${attrValue(src)}" alt="${attrValue(alt)}">`;
            f.content = true;
          } else if (linkDepth > 0 || !FIGURE_HOSTS.has(f.tag)) {
            // Inline (a link's, a paragraph's): the alt is the text in its place.
            appendBoundary();
            appendText(alt);
            appendBoundary();
          } else {
            appendBlock(f, `<figure><figcaption>${alt}</figcaption></figure>`);
            f.content = true;
          }
          stack.push({ kind: "unwrapped", boundary: false, span: false });
          return;
        }
        if (name === "br") {
          const f = keptParent();
          if (f.pre) f.html += "\n";
          else if (f.html !== "" && !/\n$/.test(f.html)) {
            f.html = f.html.replace(/ $/, "") + "<br>";
          }
          stack.push({ kind: "unwrapped", boundary: false, span: false });
          return;
        }
        const parent = keptParent();
        const kept = BLOCK.has(name) || INLINE.has(name);
        if (link !== undefined) {
          linkDepth++;
          const tag = kept && name !== "a" ? name : "a";
          const block = BLOCK.has(tag);
          if (block) parent.html = parent.html.replace(/ $/, "");
          stack.push({
            kind: "kept",
            tag,
            attrs: tag === "a" ? ` href="${attrValue(link)}"` : "",
            block,
            pre: parent.pre || tag === "pre",
            linkHref: tag === "a" ? undefined : link,
            isLink: true,
            label: attribs["aria-label"],
            svgTitle: "",
            html: "",
            content: false,
          });
          return;
        }
        if (kept && name !== "a") {
          const block = BLOCK.has(name);
          if (block) parent.html = parent.html.replace(/ $/, "");
          stack.push({
            kind: "kept",
            tag: name,
            attrs: "",
            block,
            pre: parent.pre || name === "pre",
            linkHref: undefined,
            isLink: false,
            label: undefined,
            svgTitle: "",
            html: "",
            content: false,
          });
          return;
        }
        // Unwrapped: an `a` without a destination (or nested in a link), a
        // `div`, a `span`, … Its text joins the nearest kept element — a
        // span's with no space where a word runs straight into it.
        const span = name === "span";
        const boundary = !PHRASING.has(name) && name !== "a";
        if (boundary && !(span && glued)) appendBoundary();
        stack.push({ kind: "unwrapped", boundary, span });
      },
      ontext(text) {
        if (dropDepth > 0) {
          // A drawing's <title> names the link it sits in.
          const top = stack.at(-1);
          if (top?.kind === "dropped" && top.tag === "title" && top.inSvg) {
            const link = stack.findLast(
              (f): f is KeptFrame => f.kind === "kept" && f.isLink,
            );
            if (link) link.svgTitle += text;
          }
          return;
        }
        if (spanEdge) {
          // A word written straight after a closed span runs on from it.
          if (/^\S/.test(text)) spanEdge = false;
          else settleSpanEdge();
        }
        appendText(text);
        if (text !== "") wordBefore = /\S$/.test(text);
      },
      onclosetag() {
        settleSpanEdge();
        wordBefore = false;
        const f = stack.pop();
        if (f === undefined || stack.length === 0) {
          throw new Error("[static-render] semanticHtml: unbalanced close tag");
        }
        if (f.kind === "dropped") {
          dropDepth--;
          return;
        }
        if (f.kind === "unwrapped") {
          if (f.span) spanEdge = true;
          else if (f.boundary) appendBoundary();
          return;
        }
        if (f.isLink) linkDepth--;
        const parent = keptParent();
        let inner = f.html;
        if (!f.content && f.isLink) {
          // An icon-only link keeps its accessible name as its text.
          const name = [f.label, f.svgTitle]
            .map((n) => n?.replace(/\s+/g, " ").trim() ?? "")
            .find((n) => n !== "");
          if (name !== undefined) {
            inner = name;
            f.content = true;
          }
        }
        if (!f.content) {
          // An empty wrapper: gone, but it still separated what was beside it.
          if (/\s/.test(inner) || f.block) appendBoundary();
          return;
        }
        let lead = "";
        let trail = "";
        if (!f.pre) {
          if (inner.startsWith(" ")) lead = " ";
          if (/[ \n]$/.test(inner)) trail = " ";
          inner = inner.replace(/^[ \n]+/, "").replace(/[ \n]+$/, "");
          inner = inner.replace(/(<br>)+$/, "");
        }
        if (f.linkHref !== undefined) {
          inner = `<a href="${attrValue(f.linkHref)}">${inner}</a>`;
        }
        const element = `<${f.tag}${f.attrs}>${inner}</${f.tag}>`;
        if (f.block) {
          appendBlock(parent, element);
        } else {
          if (lead) appendText(" ");
          parent.html += element;
          if (trail) appendText(" ");
        }
        parent.content = true;
      },
    },
    {
      decodeEntities: false,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
    },
  );
  parser.write(html);
  parser.end();
  if (stack.length !== 1) {
    throw new Error(
      `[static-render] semanticHtml: ${stack.length - 1} element(s) left open`,
    );
  }
  settleSpanEdge();
  flushRun();
  return root.html.trim();
}
