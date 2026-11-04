import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { serveValue } from "@plugins/network/plugins/live/machine";
import { midiFoldersStatus, recheckMidiFolders } from "../../shared/status";
import {
  folderStatuses,
  onFolderStatusChange,
  refreshFolderStatuses,
} from "./folder-status";

// The probe's result, pushed by the probe itself whenever it changed (a config
// edit, a reconcile, the user's Check again) — only while a tab reads it.
export const folderStatusServed = serveValue(midiFoldersStatus, {
  source: "external",
  changes: "notified",
  loader: () => folderStatuses(),
  whileSubscribed: (_params, notify) => onFolderStatusChange(() => notify()),
});

export const handleRecheckMidiFolders = implementMachine(
  recheckMidiFolders,
  () => refreshFolderStatuses(),
);
