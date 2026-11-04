import {
  createContext,
  useContext,
  type ReactNode,
  type RefObject,
} from "react";
import type { AnyPane } from "@plugins/primitives/plugins/pane/web";
import { useSectionReach } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/web";

/**
 * The page a website section belongs to, as its reach key spells it: the
 * pane's id without the `website-` every website pane id starts with
 * (`landing`, `vision`). Provided once by `WebsiteChrome`, so a band names
 * only itself.
 */
const PANE_ID_PREFIX = "website-";

const WebsitePageKey = createContext<string | null>(null);

export function WebsitePageKeyProvider({
  pane,
  children,
}: {
  pane: AnyPane;
  children: ReactNode;
}) {
  if (!pane.id.startsWith(PANE_ID_PREFIX))
    throw new Error(
      `WebsiteChrome: pane id "${pane.id}" does not start with "${PANE_ID_PREFIX}"`,
    );
  return (
    <WebsitePageKey.Provider value={pane.id.slice(PANE_ID_PREFIX.length)}>
      {children}
    </WebsitePageKey.Provider>
  );
}

/**
 * Records `section_reach` for this section of the current website page, as
 * `<page>/<section>` (`landing/layers`, `vision/idea`) — once per visit to the
 * page, when the section reaches the upper half of the screen. Attach the ref
 * to the section's outermost element.
 *
 * Every `WebsiteBand` does this with its required `section`, so a band cannot
 * ship unmeasured; a page drawing its own scene (the vision zoom) calls it for
 * each part it wants in the funnel.
 */
export function useWebsiteSectionReach<T extends Element>(
  section: string,
): RefObject<T | null> {
  const page = useContext(WebsitePageKey);
  if (page === null)
    throw new Error(
      `useWebsiteSectionReach("${section}"): not inside a WebsiteChrome`,
    );
  return useSectionReach<T>(`${page}/${section}`);
}
