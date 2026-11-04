import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { midiFoldersConfig } from "../shared/config";
import { folderSongCountServed } from "./internal/song-count";

export default {
  description:
    "Watched MIDI folders, every host's half: registers the watched-folder list (a config_v2 listField) and serves each folder's imported-song count (sonata.midi-folders.song-count, a count over the MIDI side-table). Watching, importing and probing the folders is the machine/ half's.",
  contributions: [
    ConfigV2.Register({ descriptor: midiFoldersConfig }),
    ...folderSongCountServed.declare,
  ],
} satisfies ServerPluginDefinition;
