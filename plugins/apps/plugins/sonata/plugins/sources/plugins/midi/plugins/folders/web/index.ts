import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import {
  Library,
  sonataLibraryPane,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { midiFoldersConfig } from "../shared/config";
import { sourceMissingPresentation } from "./internal/presentation";
import { MidiFoldersNotice } from "./internal/folder-notice";
import { MidiFoldersSettingsButton } from "./internal/folders-settings";

export default {
  description:
    "Watched-folder UI for the MIDI source: registers the midi-folders config and presents the File field (the MIDI exposure's `sourceMissing`) that flags — and lets you filter for — folder-imported songs whose file has been deleted from disk. Shows every watched folder that cannot be read (denied by macOS, missing, not a folder) as a notice on the library — which folder, why, and Allow access / Check again / Change folder / Remove — and puts the folder list itself, with each folder's status, under a Sonata settings gear in the library header.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: midiFoldersConfig }),
    sourceMissingPresentation,
    Library.Notice({ id: "midi-folders", component: MidiFoldersNotice }),
    sonataLibraryPane.Actions({
      id: "midi-folders",
      component: MidiFoldersSettingsButton,
    }),
  ],
} satisfies PluginDefinition;
