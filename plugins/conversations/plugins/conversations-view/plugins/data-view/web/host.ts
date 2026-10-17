import type { MouseEvent } from "react";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  defineDataView,
  defineDataViewSources,
} from "@plugins/primitives/plugins/data-view/web";

/**
 * The props every conversation-sidebar source receives. Owned by this umbrella —
 * the mount point (`conversations-view`) renders
 * {@link ConversationsSidebarDataView} directly and passes these, and each
 * source sub-plugin (Queue / History) consumes the same shape. Formerly lived in
 * the deleted `sidebar-region` plugin (its `ConversationSidebarProps`), moved
 * here so the sidebar renders entirely through the DataView primitive with no
 * back-edge into `conversations-view`.
 */
export interface ConversationSidebarProps {
  activeId: string | null;
  /** Where a row goes: a link, so middle- / ⌘-click open it in a browser tab. */
  linkTo: (id: string) => LinkTarget;
  onCloseConversation: (id: string, e: MouseEvent) => Promise<void>;
}

/**
 * The source slot for the merged conversation-sidebar DataView. Sub-plugins
 * under `data-view/plugins/*` contribute one source each (Queue, History); the
 * `DataViewSwitcher` host resolves ONE unified view model over them — one config
 * file, one `EditableViewSwitcher`, a source-grouped `+` add-view menu.
 */
export const SidebarSources = defineDataViewSources<ConversationSidebarProps>();

// The merged DataView surface id — the config lives under this plugin's tree at
// `config/conversations/conversations-view/data-view/conversations-sidebar.jsonc`.
export const SIDEBAR_VIEW = defineDataView("conversations-sidebar");
