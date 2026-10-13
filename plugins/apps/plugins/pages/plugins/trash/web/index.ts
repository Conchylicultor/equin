import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pages } from "@plugins/apps/plugins/pages/plugins/shell/web";
import { PagesTrash } from "./components/pages-trash";
import {
  PurgeTrashEntryAction,
  RestoreTrashEntryAction,
  TrashItemActions,
} from "./components/trash-item-actions";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Pages trash consumer: contributes a Trash entry into the Pages sidebar, opening a dialog that lists soft-deleted pages as a live DataView with Restore and Delete permanently row actions.",
  contributions: [
    Pages.Sidebar({
      id: "trash",
      title: "Trash",
      icon: symbol("delete"),
      component: PagesTrash,
    }),
    TrashItemActions({
      id: "restore",
      component: RestoreTrashEntryAction,
      zone: "persistent",
    }),
    TrashItemActions({
      id: "purge",
      component: PurgeTrashEntryAction,
      zone: "persistent",
    }),
  ],
  slots: {
    itemActions: TrashItemActions,
  },
} satisfies PluginDefinition;
