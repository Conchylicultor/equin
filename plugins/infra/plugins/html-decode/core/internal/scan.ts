import { Parser } from "htmlparser2";
import { decodeHtmlText } from "./decode";

// The portable HTML read and the two in-place edits, on htmlparser2's streaming
// parser — plain JS, so every host runs them (a browser worker has neither
// Bun's `HTMLRewriter` nor `DOMParser`).
//
// The parser runs with `decodeEntities: false`: every value is read out of the
// raw source and decoded here, exactly once, through `decodeHtmlText` — the
// same decode the `HTMLRewriter` callers applied — so a value read through this
// module cannot be the undecoded source, and cannot be decoded twice.
//
// An edit splices the source by index: only the bytes it changes are replaced,
// every other byte of the document — the edited tag's untouched attributes and
// the whitespace between them included — comes back exactly as written.

/** A start tag the scanner met. */
export interface ScannedElement {
  /** The tag name, lower-cased. */
  readonly name: string;
  /** Its attribute names, lower-cased, in source order; a repeated name once. */
  readonly attributeNames: readonly string[];
  /**
   * The decoded value of the attribute, `undefined` when absent (`""` for a
   * bare `<x hidden>`). A repeated attribute reads its first occurrence, as
   * the browser does.
   */
  attr(name: string): string | undefined;
}

/** What `scanHtml` reports, keyed by lower-cased tag name. */
export interface ScanHandlers {
  /** Each start tag of the name, in document order. */
  readonly elements?: Readonly<Record<string, (el: ScannedElement) => void>>;
  /**
   * Each element of the name as it closes, with its text content (comments
   * and markup excluded) decoded once — so an empty `<title></title>` reports
   * `""`. In document order of the closings.
   */
  readonly text?: Readonly<Record<string, (text: string) => void>>;
}

/**
 * The outcome of an edit of a document's first `<tag>`: the edited document,
 * or `absent` when the document has no such element — a type, so an edit that
 * found nothing to edit cannot pass for one that did.
 */
export type HtmlEdit = { kind: "edited"; html: string } | { kind: "absent" };

/** A start tag being rewritten by {@link rewriteStartTag}. */
export interface StartTagEditor extends ScannedElement {
  /**
   * Set the attribute to `value` (plain text — escaped on the way in). An
   * existing attribute is rewritten where it stands, a new one is appended
   * after the last.
   */
  setAttribute(name: string, value: string): void;
}

/** One attribute as written: its span in the source and its raw value. */
interface RawAttribute {
  /** Lower-cased. */
  name: string;
  /** As written (`STYLE`), for a rewrite that keeps the author's spelling. */
  sourceName: string;
  raw: string;
  /** `[start, end)` of `name="value"` in the source. */
  start: number;
  end: number;
}

/** A start tag with the source positions an edit splices at. */
interface RawStartTag {
  name: string;
  /** First occurrence of each name, in source order. */
  attributes: RawAttribute[];
  /** Index of the `<`. */
  start: number;
  /** Index just past the tag name: where a first attribute would go. */
  nameEnd: number;
  /** Index of the closing `>`. */
  end: number;
}

interface Walker {
  onStartTag?(tag: RawStartTag): void;
  onText?(raw: string): void;
  /** `start` is the index of the end tag's `<`; `null` when the close is implied. */
  onEndTag?(name: string, start: number | null): void;
}

function walk(html: string, walker: Walker): void {
  let attributes: RawAttribute[] = [];
  let nameEnd = 0;
  const parser: Parser = new Parser(
    {
      onopentagname() {
        attributes = [];
        nameEnd = parser.endIndex;
      },
      onattribute(name) {
        if (attributes.some((a) => a.name === name)) return;
        const start = parser.startIndex;
        const end = parser.endIndex;
        const sourceName = /^[^\s/>=]+/.exec(html.slice(start, end))?.[0];
        if (sourceName === undefined) {
          throw new Error(
            `html-decode: no attribute name at ${start} in ${JSON.stringify(html.slice(start, end))}`,
          );
        }
        attributes.push({
          name,
          sourceName,
          raw: rawAttributeValue(html.slice(start + sourceName.length, end)),
          start,
          end,
        });
      },
      onopentag(name) {
        walker.onStartTag?.({
          name,
          attributes,
          start: parser.startIndex,
          nameEnd,
          end: parser.endIndex,
        });
        attributes = [];
      },
      ontext(data) {
        walker.onText?.(data);
      },
      onclosetag(name, isImplied) {
        walker.onEndTag?.(name, isImplied ? null : parser.startIndex);
      },
    },
    { decodeEntities: false },
  );
  parser.end(html);
}

/**
 * The raw value out of an attribute's source after its name: `="v"`, `='v'`,
 * `=v`, or nothing (a bare attribute, value `""`). Read off the source rather
 * than the parser's value so it is the bytes as written, never decoded.
 */
function rawAttributeValue(afterName: string): string {
  const eq = afterName.indexOf("=");
  if (eq < 0) return "";
  const value = afterName.slice(eq + 1).trimStart();
  const quote = value[0];
  if (quote === '"' || quote === "'") return value.slice(1, -1);
  return value;
}

function scannedElement(tag: RawStartTag): ScannedElement {
  return {
    name: tag.name,
    attributeNames: tag.attributes.map((a) => a.name),
    attr(name) {
      const found = tag.attributes.find((a) => a.name === name);
      return found === undefined ? undefined : decodeHtmlText(found.raw);
    },
  };
}

/**
 * Read a document: call `handlers.elements[name]` on every start tag of that
 * name and `handlers.text[name]` with every such element's text, in document
 * order. Tag names are matched lower-cased; the content of `<script>`,
 * `<style>`, `<textarea>` and an HTML `<title>` is text, never tags, and
 * nothing inside a comment is reported.
 */
export function scanHtml(html: string, handlers: ScanHandlers): void {
  const { elements = {}, text = {} } = handlers;
  /** Text accumulated per open element whose text is wanted, innermost last. */
  const open: { name: string; chunks: string[] }[] = [];
  walk(html, {
    onStartTag(tag) {
      if (Object.hasOwn(elements, tag.name)) {
        elements[tag.name]!(scannedElement(tag));
      }
      if (Object.hasOwn(text, tag.name))
        open.push({ name: tag.name, chunks: [] });
    },
    onText(raw) {
      for (const el of open) el.chunks.push(raw);
    },
    onEndTag(name) {
      if (!Object.hasOwn(text, name)) return;
      const at = open.findLastIndex((el) => el.name === name);
      if (at < 0) return;
      const [el] = open.splice(at, 1);
      // Accumulated first and decoded once: a character reference can
      // straddle two text events.
      text[name]!(decodeHtmlText(el!.chunks.join("")));
    },
  });
}

/** The first start tag named `tagName`, with its end tag's `<` (`null` if implied). */
function firstElement(
  html: string,
  tagName: string,
): { tag: RawStartTag; endTagStart: number | null } | null {
  // Held in arrays, not `let`s, so the reads after the walk see what its
  // callbacks wrote.
  const first: RawStartTag[] = [];
  const endTag: (number | null)[] = [];
  let depth = 0;
  walk(html, {
    onStartTag(t) {
      if (t.name !== tagName) return;
      if (first.length === 0) first.push(t);
      else if (endTag.length === 0) depth++;
    },
    onEndTag(name, start) {
      if (name !== tagName || first.length === 0 || endTag.length > 0) return;
      if (depth > 0) depth--;
      else endTag.push(start);
    },
  });
  const tag = first[0];
  if (tag === undefined) return null;
  return { tag, endTagStart: endTag[0] ?? null };
}

/** `value` as a double-quoted attribute value. */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/** `text` as element text. */
function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Edit the attributes of the document's FIRST `<tagName>` — a later one (a
 * second literal `<html>` in the body) is not the element meant — and splice
 * the result into the source: a set attribute is rewritten where it stands as
 * `name="value"` (keeping the author's spelling of the name), a new one is
 * appended after the last, and every other byte is returned as written.
 */
export function rewriteStartTag(
  html: string,
  tagName: string,
  edit: (el: StartTagEditor) => void,
): HtmlEdit {
  const found = firstElement(html, tagName);
  if (found === null) return { kind: "absent" };
  const { tag } = found;
  const set = new Map<string, string>();
  edit({
    ...scannedElement(tag),
    setAttribute(name, value) {
      set.set(name.toLowerCase(), value);
    },
  });

  // Splices, applied from the end so earlier indices stay valid.
  const splices: { start: number; end: number; text: string }[] = [];
  const appended: string[] = [];
  for (const [name, value] of set) {
    const existing = tag.attributes.find((a) => a.name === name);
    if (existing === undefined) {
      appended.push(` ${name}="${escapeAttribute(value)}"`);
    } else {
      splices.push({
        start: existing.start,
        end: existing.end,
        text: `${existing.sourceName}="${escapeAttribute(value)}"`,
      });
    }
  }
  if (appended.length > 0) {
    const at = tag.attributes.at(-1)?.end ?? tag.nameEnd;
    splices.push({ start: at, end: at, text: appended.join("") });
  }
  splices.sort((a, b) => b.start - a.start);
  let out = html;
  for (const s of splices) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return { kind: "edited", html: out };
}

/**
 * Replace the content of the document's FIRST `<tagName>` with `text` (plain
 * text — escaped on the way in); every other byte is returned as written.
 * Throws when that element has no end tag of its own: where its content ends
 * is then the parser's guess, not something the source says.
 */
export function replaceElementText(
  html: string,
  tagName: string,
  text: string,
): HtmlEdit {
  const found = firstElement(html, tagName);
  if (found === null) return { kind: "absent" };
  if (found.endTagStart === null) {
    throw new Error(
      `html-decode: the first <${tagName}> has no </${tagName}>, so where its content ends is not written in the source`,
    );
  }
  return {
    kind: "edited",
    html:
      html.slice(0, found.tag.end + 1) +
      escapeText(text) +
      html.slice(found.endTagStart),
  };
}
