import type { ReactNode } from "react";
import { useAppLink } from "@plugins/apps-core/plugins/tabs/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { navIcons } from "@plugins/ui/plugins/icons/core";
import type { PageMapActionProps } from "@plugins/page/plugins/map/web";
import { placesApp } from "@plugins/apps/plugins/places/plugins/shell/core";
import { placesMapRoute } from "../../core";

/**
 * The page map's "Open in Places" (a `PageMap.Action`): an icon button with
 * the expand glyph a pane's own cross-app Expand ("Open in <App>") draws,
 * floating over the map's tiles. It links to the Places map with this page's
 * places laid over yours (`/places;page=<pageId>`, the map pane's `;page`
 * view) — a link, so ⌘/middle-click opens it in a new browser tab — and stops
 * there: the click is not also the editor's (the map sits in a block).
 */
export function OpenInPlacesAction({ pageId }: PageMapActionProps): ReactNode {
  const inAppLink = useAppLink();
  return (
    <IconButton
      variant="floating"
      icon={navIcons.expand}
      label={`Open in ${placesApp.name}`}
      {...activationProps(
        inAppLink(placesMapRoute.link(placesApp, { page: pageId })),
        { isolate: true },
      )}
    />
  );
}
