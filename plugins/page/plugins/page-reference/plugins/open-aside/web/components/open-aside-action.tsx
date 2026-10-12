import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  usePageNavigation,
  type PageNavigation,
  type PageReferenceActionProps,
} from "@plugins/page/plugins/page-reference/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";

/**
 * Only where the host declared it can put a page beside the one being read.
 * Declared as the contribution's `available` rather than checked in the body, so
 * a reference in a single-surface embed paints no action cluster whatsoever —
 * see `page-reference`'s CLAUDE.md.
 */
export function canOpenAside(nav: PageNavigation | undefined): boolean {
  return nav?.openAside !== undefined;
}

/**
 * Open the referenced page in a column beside the one it is referenced from,
 * leaving the current page on screen. The reference's own click still opens it
 * in place; this is the second intent, and it is a button precisely because the
 * row's click can only carry one. A link like the reference itself:
 * ⌘/middle-click opens the page in a new browser tab.
 */
export function OpenAsideAction({ pageId }: PageReferenceActionProps) {
  const openAside = usePageNavigation()?.openAside;
  // `canOpenAside` already kept this off screen wherever there is no second
  // column; this is the narrowing that lets the handler be written at all.
  if (!openAside) return null;
  return (
    <IconButton
      icon={navIcons.sidePane}
      label="Open in side pane"
      {...linkProps(openAside(pageId))}
    />
  );
}
