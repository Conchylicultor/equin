import { liveCollection } from "@plugins/network/plugins/live/core";
import { songMidiShape } from "../core";

// The MIDI row of ONE song, read by its `songId` — the attachment the player
// hydrates the song's bytes from. The side-table holds 0 or 1 row per song
// (its primary key IS the song), so it is a lookup-only collection: it mints
// `sonata.midi:rows` alone. `found: false` is "this song carries no MIDI".
// Bounded by construction: only a song being opened subscribes, and a load is
// one primary-key seek.
export const songMidiRows = liveCollection("sonata.midi", {
  from: songMidiShape,
  id: "songId",
});
