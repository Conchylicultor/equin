import type { RemarkPlugins } from "@plugins/primitives/plugins/markdown/web";
import { parseAttrs, TAG_ATTRS_SOURCE } from "./tag-attrs";

const OPEN_TAG_RE = new RegExp(`^<([\\w-]+)${TAG_ATTRS_SOURCE}?>$`);

/**
 * The element an inline active-data tag becomes in the markdown output: the
 * enhancer maps it to the contribution's `inline` renderer, by its `data-tag`.
 */
export const INLINE_TAG_ELEMENT = "active-data-inline-tag";

// The slice of mdast this pass touches — kept local rather than adding the
// @types/mdast dependency for four fields.
interface Point {
  offset?: number;
}
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: Point; end: Point };
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
}

function offsetOf(point: Point | undefined, what: string): number {
  // remark-parse positions every node it makes; a missing offset means the tree
  // came from elsewhere and the source slice below would be wrong.
  if (point?.offset === undefined)
    throw new Error(`Inline active-data tag: ${what} has no source offset`);
  return point.offset;
}

/**
 * Pairs an inline `<tag …>` and its `</tag>` — two separate `html` nodes among
 * one paragraph's children, since CommonMark reads a tag beside prose as inline
 * HTML — into ONE element wrapping the nodes between them, so the markdown in
 * between (emphasis, code, links) still renders and the tag's renderer receives
 * it as children. An open tag without its close in the same parent (a blank
 * line inside, a typo) is left as written: visible, not silently dropped.
 */
function pairInlineTags(
  tags: ReadonlySet<string>,
  source: string,
  parent: MdNode,
): void {
  const children = parent.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const open = children[i]!;
    const opened =
      open.type === "html" ? OPEN_TAG_RE.exec(open.value ?? "") : null;
    if (!opened || !tags.has(opened[1]!)) continue;
    const tag = opened[1]!;
    const closeAt = children.findIndex(
      (n, j) => j > i && n.type === "html" && n.value === `</${tag}>`,
    );
    if (closeAt === -1) continue;
    const close = children[closeAt]!;
    const inner = children.slice(i + 1, closeAt);
    const content = source.slice(
      offsetOf(open.position?.end, `<${tag}>`),
      offsetOf(close.position?.start, `</${tag}>`),
    );
    const attrStr = (opened[2] ?? "").trim();
    const node: MdNode = {
      type: "activeDataInline",
      children: inner,
      data: {
        hName: INLINE_TAG_ELEMENT,
        hProperties: {
          dataTag: tag,
          dataContent: content.trim(),
          dataAttrs: JSON.stringify(attrStr ? parseAttrs(attrStr) : {}),
        },
      },
    };
    children.splice(i, closeAt - i + 1, node);
  }
  for (const child of children) pairInlineTags(tags, source, child);
}

/** The remark plugin pairing every inline occurrence of `tags`. */
export function remarkInlineTags(tags: readonly string[]): RemarkPlugins {
  const set = new Set(tags);
  const plugin = () => (tree: MdNode, file: { value: unknown }) => {
    pairInlineTags(set, String(file.value), tree);
  };
  return [plugin as RemarkPlugins[number]];
}
