import { liveCollection } from "@plugins/network/plugins/live/core";
import { ugAlignmentShape } from "../core";

// The alignment row of ONE song, read by its `songId`. The side-table holds 0 or
// 1 row per song — its primary key IS the song — so it is a lookup-only
// collection: nothing lists every song's alignment, so it mints
// `sonata-ug-alignment:rows` alone. A reader takes its row with
// `useLiveRow(ugAlignmentRows, songId)`; `found: false` is "this song never had
// a video".
//
// Bounded by construction: only an open UG song subscribes (the sync effect and
// the Recording section), a load is one primary-key seek, and the `:rows` point
// routing schedules a job's write for the one song whose row it named.
export const ugAlignmentRows = liveCollection("sonata-ug-alignment", {
  from: ugAlignmentShape,
  id: "songId",
});
