import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { writeSongFixtures } from "./internal/write-songs";

export default {
  description:
    "Sonata fixtures, server half: writeSongFixtures writes SongFixtures through each source's real write path — a chord grid through the chord-grid source's create write (measured as the editor does), a MIDI or MusicXML file through its source's import into a song created under the fixture's id. Derives nothing else.",
} satisfies ServerPluginDefinition;
