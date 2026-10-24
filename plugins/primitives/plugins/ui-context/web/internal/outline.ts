import {
  formatLineagePath,
  parseElementDescriptor,
  parseLineagePath,
} from "../../core";
import { collectLineage } from "./collect-lineage";
import { describeElement } from "./collect-meta";
import { INTERACTIVE_SELECTOR, isDrawn, withdraws } from "./shown";

/**
 * One control on the page, named the way a `<ui-context>` token names an
 * element: `path` is its lineage (`formatLineagePath`, as the token's `path=`
 * writes it — `""` outside every lineage node) and `element` its descriptor
 * (`formatElementDescriptor`, e.g. `button — Share`). `count` is how many
 * shown controls share both (a list's row actions): more than one, and a
 * resolve of the pair is `ambiguous`.
 */
export interface UiOutlineEntry {
  readonly path: string;
  readonly element: string;
  readonly count: number;
}

export interface UiOutline {
  /** Distinct (path, element) pairs, in document order of first appearance. */
  readonly entries: readonly UiOutlineEntry[];
  /** True when the page held more distinct controls than `limit`. */
  readonly truncated: boolean;
}

export interface CollectOutlineOptions {
  /** Subtrees left out (the surface asking, so it does not list itself). */
  readonly exclude?: readonly Element[];
  /** At most this many distinct entries. Default {@link DEFAULT_OUTLINE_LIMIT}. */
  readonly limit?: number;
}

export const DEFAULT_OUTLINE_LIMIT = 150;

/** Subtrees that hold no controls a person operates. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "svg"]);

/**
 * The page's controls, as an agent can name them: every shown interactive
 * element with an accessible name under `root`, as `{ path, element }` — the
 * two fields a `<ui-context>` token uses — in document order, capped at
 * `limit` distinct entries.
 *
 * A subtree that is hidden, `aria-hidden`, inert or excluded is pruned whole;
 * a control is kept only when it is drawn (`isDrawn`: a box with area, not
 * `visibility: hidden`). Off-screen controls a scroll away are kept.
 *
 * Its inverse is {@link resolveUiContext}: every entry resolves back to the
 * element(s) it was read from.
 */
export function collectOutline(
  root: Element,
  opts: CollectOutlineOptions = {},
): UiOutline {
  const limit = opts.limit ?? DEFAULT_OUTLINE_LIMIT;
  const exclude = new Set(opts.exclude ?? []);
  const byKey = new Map<
    string,
    { path: string; element: string; count: number }
  >();
  let truncated = false;

  const visit = (el: Element): boolean => {
    if (exclude.has(el) || SKIP_TAGS.has(el.tagName) || withdraws(el))
      return true;
    if (el.matches(INTERACTIVE_SELECTOR) && isDrawn(el)) {
      const element = describeElement(el);
      if (parseElementDescriptor(element)?.name) {
        const path = formatLineagePath(collectLineage(el));
        const key = `${path}\n${element}`;
        const seen = byKey.get(key);
        if (seen) seen.count++;
        else if (byKey.size === limit) {
          truncated = true;
          return false;
        } else byKey.set(key, { path, element, count: 1 });
      }
    }
    for (const child of el.children) if (!visit(child)) return false;
    return true;
  };
  visit(root);
  return { entries: [...byKey.values()], truncated };
}

interface TrieNode {
  readonly children: Map<string, TrieNode>;
  readonly entries: UiOutlineEntry[];
}

const trieNode = (): TrieNode => ({ children: new Map(), entries: [] });

const INDENT = "  ";

/**
 * The outline as compact model-facing text: an indented tree whose inner
 * lines are lineage segments (shared prefixes printed once; a chain of
 * segments with nothing of its own but one child is folded onto one line,
 * joined by ` > `) and whose leaves are element descriptors (`×N` when N
 * controls share it).
 *
 * An entry's `path` is the segments on the lines above it, outermost first,
 * joined by ` > ` — exactly a `<ui-context path=…>`; its `element` is the
 * leaf line without the `×N`. Groups are printed in order of first
 * appearance, a group's own controls before its sub-groups.
 *
 * ```
 * apps.pages.shell@apps.app > pages/page#pane:page[column 1 of 1]
 *   pages/share@PaneToolbar.Item
 *     button — Share
 * ```
 */
export function formatOutline(outline: UiOutline): string {
  const root = trieNode();
  for (const entry of outline.entries) {
    let node = root;
    for (const seg of parseLineagePath(entry.path)) {
      const key = formatLineagePath([seg]);
      let next = node.children.get(key);
      if (!next) {
        next = trieNode();
        node.children.set(key, next);
      }
      node = next;
    }
    node.entries.push(entry);
  }

  const lines: string[] = [];
  const print = (node: TrieNode, depth: number) => {
    const pad = INDENT.repeat(depth);
    for (const e of node.entries)
      lines.push(`${pad}${e.element}${e.count > 1 ? ` ×${e.count}` : ""}`);
    for (const [seg, child] of node.children) {
      const label = [seg];
      let cur = child;
      while (cur.entries.length === 0 && cur.children.size === 1) {
        const [nextSeg, next] = cur.children.entries().next().value!;
        label.push(nextSeg);
        cur = next;
      }
      lines.push(`${pad}${label.join(" > ")}`);
      print(cur, depth + 1);
    }
  };
  print(root, 0);
  if (outline.truncated)
    lines.push(
      `… more controls not listed (capped at ${outline.entries.length})`,
    );
  return lines.join("\n");
}
