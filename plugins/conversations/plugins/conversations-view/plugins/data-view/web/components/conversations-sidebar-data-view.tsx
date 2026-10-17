import type { ReactElement } from "react";
import { DataViewSwitcher } from "@plugins/primitives/plugins/data-view/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Separator } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  SidebarSources,
  SIDEBAR_VIEW,
  type ConversationSidebarProps,
} from "../host";
import { SIDEBAR_TOOLBAR } from "./sidebar-frame";

/**
 * The conversation sidebar as ONE merged DataView surface: view-instances bind
 * to the contributed sources (Queue, History) via the config rows' `source`
 * key, under a single unified switcher.
 *
 * A hairline sets the list apart from the nav rows above it, so the view
 * switcher below reads as its own control rather than as one more nav link.
 * The rule sits OUTSIDE the scroller: it divides the sidebar, it is not part
 * of the list, so it stays put while the list scrolls under the switcher.
 *
 * `<Scroll axis="y" fill>` is the ONE scroll ancestor. The mount point is a
 * `Shell.Sidebar` fill contribution (a flex column cell), the DataView never
 * owns a scroller, and the sticky toolbar / live-scroll sentinel / row
 * virtualization all bind to this single scroll viewport.
 *
 * The chrome is the sidebar's own ({@link SIDEBAR_TOOLBAR}): one sticky line
 * holding the view switcher as a full-width row and the options trigger. The
 * group headers are `"quiet"` — "Queue 6", with the fold chevron on hover — so
 * they read as captions over the rows rather than as a second band of chrome.
 */
export function ConversationsSidebarDataView(
  props: ConversationSidebarProps,
): ReactElement {
  return (
    <Stack gap="none" className="h-full min-h-0">
      <Inset x="md" t="md" b="xs">
        <Separator className="bg-sidebar-border" />
      </Inset>
      <Scroll axis="y" fill>
        <DataViewSwitcher
          storageKey={SIDEBAR_VIEW}
          sources={SidebarSources}
          hostProps={props}
          defaultView="queue"
          toolbar={SIDEBAR_TOOLBAR}
          groupHeaders="quiet"
        />
      </Scroll>
    </Stack>
  );
}
