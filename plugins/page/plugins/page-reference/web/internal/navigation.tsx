import { createContext, useContext, type ReactNode } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";

/**
 * How a reference to another page — a sub-page row, a link block, an inline
 * mention chip — opens what it points at.
 *
 * A reference knows WHICH page it names. It can never know where that page
 * should appear, because that answer belongs to the surface the editor is
 * mounted in: the Pages app has Miller columns to open one beside another, the
 * website's editor toy is a single box with nowhere else to put anything, and a
 * read-only render has no navigation at all. So the host declares the answer
 * once and every reference below it reads it from here.
 *
 * Context rather than a prop on `<BlockEditor>`, which is what this replaced.
 * The editor's store is COMPOSITE — one feed per expanded nested page, unioned
 * into a single store — so a threaded callback had to be restated at roughly
 * twenty points between the host and the row that finally called it, and every
 * new intent would have restated all of them again. Context crosses the
 * composite store for free, so a second intent (`openAside`) costs one field
 * here and nothing anywhere else.
 *
 * Every intent returns a {@link LinkTarget} rather than navigating: a reference
 * is a link, so a ⌘/Ctrl- or middle-click on it opens the destination in a new
 * browser tab, and that needs the destination's URL (`href`) as well as the
 * in-place open. The reference spreads it (`activationProps`), or runs it
 * (`runActivation`) where the activation has no mouse event (Enter on a row).
 */
export interface PageNavigation {
  /** Open the page IN PLACE — in the surface the reference itself lives in. */
  open(pageId: string): LinkTarget;
  /**
   * Open the page BESIDE the current one, keeping it in view.
   *
   * Optional because a host may genuinely have no second place to put it: a
   * single-surface embed can only replace what it is showing. That is not a
   * lesser `openAside` to be aliased onto `open` — opening "aside" into the same
   * box is a different action than the one the user asked for — so the seam says
   * the capability is MISSING, and the affordance for it then does not appear.
   */
  openAside?(pageId: string): LinkTarget;
  /**
   * Open ONE BLOCK of a page as a page of its own — that block and its nested
   * lines, editable, saving to the page that holds it — beside the current one.
   *
   * Optional for the same reason as `openAside`: a host with nowhere to put a
   * block view declares none, and the "Open as page" affordance is then absent.
   */
  openBlock?(blockId: string): LinkTarget;
}

const PageNavigationContext = createContext<PageNavigation | undefined>(
  undefined,
);

/**
 * Declares how page references rendered under `children` navigate. Mount it
 * around the surface that hosts the editor, not around each editor: sections
 * beside the page (the backlinks list) are references too.
 *
 * `value` must be stable across renders (`useMemo`) — a fresh object each render
 * re-renders every reference on the page.
 */
export function PageNavigationProvider({
  value,
  children,
}: {
  value: PageNavigation;
  children: ReactNode;
}) {
  return (
    <PageNavigationContext.Provider value={value}>
      {children}
    </PageNavigationContext.Provider>
  );
}

/**
 * The navigation the host declared, or `undefined` when it declared none — the
 * page is being rendered somewhere with nowhere to go. References stay inert
 * then — they still paint, they just do nothing when clicked.
 */
export function usePageNavigation(): PageNavigation | undefined {
  return useContext(PageNavigationContext);
}
