import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { FileExplorer } from "@plugins/apps/plugins/file-explorer/plugins/shell/web";
import { filesDataAtPane, filesDataPane } from "./panes";
import { useAppDataPlace } from "./internal/place";

export default {
  description:
    "The file explorer's App data place: a Locations entry leading to every file root an app declares browsable (data-files.roots — the root ids are the server's, the explorer names none), each browsed read-only at /files/data/<root>[/<path>] — a folder's entries as a paged live DataView list, a file previewed beside its folder through the file viewer (a data FileRef) — on every host: the computer's disk on the desktop, memory in a browser host.",
  slots: {
    "files-data": filesDataPane,
    "files-data-at": filesDataAtPane,
  },
  contributions: [
    Pane.Register({ pane: filesDataPane }),
    Pane.Register({ pane: filesDataAtPane }),
    FileExplorer.Places({
      id: "app-data",
      group: "locations",
      usePlaces: useAppDataPlace,
    }),
  ],
} satisfies PluginDefinition;
