import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { playbackHistoryShape } from "../../shared/shape";

/**
 * The Plays / Last played fields of every list of songs — the playback
 * exposure's (`playbackHistoryShape`). Each sorts and filters on the server:
 * "Most played" / "Recently played" are plain config sort presets over
 * `playCount` / `lastPlayedAt`, and "Unplayed" a filter preset.
 */
export const playbackPresentation = FieldPresentation.Register({
  owner: playbackHistoryShape.exposure,
  fields: {
    playCount: {
      // The copy the old per-card `PlayStats` strip owned, recovered as this
      // field's cell — so the number reads as a sentence on the card (and in
      // the table) instead of a bare `0`.
      cell: (n) =>
        n ? `${n} ${n === 1 ? "play" : "plays"}` : "Not played yet",
      // Wide enough for the cell's longest string ("Not played yet"), not
      // just for the digits — at 5rem the unplayed case clipped mid-word.
      width: "8rem",
      align: "end",
    },
    lastPlayedAt: {
      cell: (at) => (at ? formatRelativeTime(at) : "—"),
      width: "8rem",
    },
  },
});
