import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  RestoreVersionAction,
  VersionItemActions,
} from "./components/version-item-actions";

export { VersionHistoryDialog } from "./components/version-history-dialog";
export type { VersionHistoryDialogProps } from "./components/version-history-dialog";

export default {
  description:
    "Reusable version-history UI: the <VersionHistoryDialog> dialog — the timeline as a live DataView with a Restore row action, the active version's preview injected via renderPreview, navigation owned by the host.",
  contributions: [
    VersionItemActions({ id: "restore", component: RestoreVersionAction }),
  ],
  slots: {
    itemActions: VersionItemActions,
  },
} satisfies PluginDefinition;
