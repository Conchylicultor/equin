import { PAGE_BLOCK_TYPE } from "@plugins/page/plugins/editor/core";
import type { TagColor } from "@plugins/page/plugins/tags/core";

/** A content block: its type and its text (a to-do's checked state too). */
export type PageFixtureBlock =
  | { id: string; type: "text" | "heading-2" | "prompt"; text: string }
  | { id: string; type: "to-do"; text: string; checked: boolean };

/** A page: its title, its sidebar state, and its body in document order. */
export interface PageFixture {
  id: string;
  type: typeof PAGE_BLOCK_TYPE;
  title: string;
  /** Tag names, created in the vocabulary with this colour when absent. */
  tags?: readonly { name: string; color: TagColor }[];
  starred?: true;
  children: readonly PageFixtureNode[];
}

export type PageFixtureNode = PageFixtureBlock | PageFixture;

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
