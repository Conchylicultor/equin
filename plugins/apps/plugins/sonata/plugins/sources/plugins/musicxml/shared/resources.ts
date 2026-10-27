import { liveCollection } from "@plugins/network/plugins/live/core";
import { songMusicXmlShape } from "./shape";

// The MusicXML row of ONE song, read by its `songId` — the attachment the
// player hydrates the song's document from. The side-table holds 0 or 1 row
// per song (its primary key IS the song), so it is a lookup-only collection:
// it mints `sonata.musicxml:rows` alone. `found: false` is "this song carries
// no MusicXML". Bounded by construction: only a song being opened subscribes,
// and a load is one primary-key seek.
export const songMusicXmlRows = liveCollection("sonata.musicxml", {
  from: songMusicXmlShape,
  id: "songId",
});
