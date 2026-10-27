import { serveCollection } from "@plugins/network/plugins/live/server";
import { songMidiRows } from "../../shared/resources";
import { songMidi } from "./tables";

// Server half of the per-song MIDI read: the lookup-only collection served
// from the extension entity (`songId` is the `parent_id` PK).
export const songMidiRowsServed = serveCollection(songMidiRows, {
  from: songMidi,
});
