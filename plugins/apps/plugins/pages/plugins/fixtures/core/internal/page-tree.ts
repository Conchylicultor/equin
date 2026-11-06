import {
  PAGE_BLOCK_TYPE,
  type PageCover,
} from "@plugins/page/plugins/editor/core";
import type { TagColor } from "@plugins/page/plugins/tags/core";
import type { Emoji } from "@plugins/ui/plugins/icons/plugins/emoji/core";

/** A content block: its type and its text (a to-do's checked state too). */
export type PageFixtureBlock =
  | { id: string; type: "text" | "heading-2" | "prompt"; text: string }
  | { id: string; type: "to-do"; text: string; checked: boolean };

/**
 * A run of content blocks written as the page's own markdown — the dialect
 * `read_page` emits and `edit_page` reads (`page/markdown-apply`): any block
 * type the editor registers (headings, lists, toggles, callouts, quotes, code,
 * tables, equations, prototypes, instructions cards…), inline marks and page
 * links (`pageLinkToken`). Its blocks get fresh ids, so nothing else can name
 * one; a block another record points at (a prompt a task was launched from) is
 * a {@link PageFixtureBlock} with the caller's id.
 */
export interface PageFixtureMarkdown {
  type: "markdown";
  markdown: string;
}

/** A page: its title, its sidebar state, and its body in document order. */
export interface PageFixture {
  id: string;
  type: typeof PAGE_BLOCK_TYPE;
  title: string;
  /** The page's icon; absent = none (the default document glyph). */
  icon?: Emoji;
  /** The page's cover (a gradient preset, or an attachment); absent = none. */
  cover?: PageCover;
  /** Tag names, created in the vocabulary with this colour when absent. */
  tags?: readonly { name: string; color: TagColor }[];
  starred?: true;
  children: readonly PageFixtureNode[];
}

export type PageFixtureNode =
  PageFixtureBlock | PageFixtureMarkdown | PageFixture;

/**
 * Some pages, as a pure tree: the workspace's root pages in sidebar order,
 * each with its body and sub-pages. Ids are the caller's (a demo stamps its
 * own), so a fixture can name its pages from other data — a page link, a
 * prompt block a task was launched from.
 */
export type PageTreeFixture = readonly PageFixture[];

/** Every page of `tree`, sub-pages included, in document order. */
export function fixturePages(tree: PageTreeFixture): PageFixture[] {
  return tree.flatMap(pagesIn);
}

function pagesIn(page: PageFixture): PageFixture[] {
  return [
    page,
    ...page.children.flatMap((c) =>
      c.type === PAGE_BLOCK_TYPE ? pagesIn(c) : [],
    ),
  ];
}
