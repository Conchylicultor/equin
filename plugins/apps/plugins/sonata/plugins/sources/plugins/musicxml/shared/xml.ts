/**
 * A minimal ordered element tree over `fast-xml-parser`.
 *
 * MusicXML is order-sensitive — inside a `<measure>`, `<note>`, `<backup>`,
 * `<forward>`, `<direction>` and `<harmony>` interleave, and their order IS the
 * timing — so the document is parsed with `preserveOrder` and folded into plain
 * `{ name, attrs, children, text }` nodes the MusicXML reader walks. Pure, works
 * in the browser and on the server.
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";

/** One XML element: its tag, attributes, child elements (in order) and text. */
export interface XmlElement {
  name: string;
  attrs: Readonly<Record<string, string>>;
  children: readonly XmlElement[];
  /** The element's own text content (its text nodes joined), trimmed. */
  text: string;
}

const ATTRS_KEY = ":@";
const TEXT_KEY = "#text";

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  // Keep every value a string: the reader decides what is a number.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toAttrs(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const [k, val] of Object.entries(v)) out[k] = String(val);
  return out;
}

function toElements(nodes: unknown): XmlElement[] {
  if (!Array.isArray(nodes)) return [];
  const out: XmlElement[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === ATTRS_KEY || key === TEXT_KEY) continue;
      // Processing instructions (`?xml`) carry no content.
      if (key.startsWith("?")) continue;
      const kids = Array.isArray(value) ? value : [];
      const text = kids
        .map((k) => (isRecord(k) && TEXT_KEY in k ? String(k[TEXT_KEY]) : ""))
        .join("")
        .trim();
      out.push({
        name: key,
        attrs: toAttrs(node[ATTRS_KEY]),
        children: toElements(kids),
        text,
      });
    }
  }
  return out;
}

/**
 * Parse an XML document into its top-level elements. Returns the validator's
 * message instead of a tree when the text is not well-formed XML.
 */
export function parseXml(
  xml: string,
): { ok: true; elements: XmlElement[] } | { ok: false; message: string } {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    return {
      ok: false,
      message: `${valid.err.msg} (line ${valid.err.line}, column ${valid.err.col})`,
    };
  }
  const parsed: unknown = parser.parse(xml);
  return { ok: true, elements: toElements(parsed) };
}

/** The first child named `name`, or undefined. */
export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

/** Every child named `name`, in document order. */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

/** The text of the first child named `name`, or undefined when absent. */
export function childText(el: XmlElement, name: string): string | undefined {
  return child(el, name)?.text;
}
