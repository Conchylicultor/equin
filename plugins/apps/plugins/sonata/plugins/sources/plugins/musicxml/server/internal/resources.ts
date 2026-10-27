import { serveCollection } from "@plugins/network/plugins/live/server";
import { songMusicXmlRows } from "../../shared/resources";
import { songMusicXml } from "./tables";

// Server half of the per-song MusicXML read: the lookup-only collection served
// from the extension entity (`songId` is the `parent_id` PK).
export const songMusicXmlRowsServed = serveCollection(songMusicXmlRows, {
  from: songMusicXml,
});
