import type { ReactNode } from "react";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import type { FieldExtent } from "@plugins/network/plugins/live/core";
import { formatRelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Clip } from "@plugins/primitives/plugins/css/plugins/clip/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { rigidClass } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { playbackHistoryShape } from "../../shared/shape";

const playsIcon = symbol("play-arrow");
const lastPlayedIcon = symbol("history");

/**
 * A play count as a cell: the number, then a short bar of it against the
 * most-played song the view shows (`extent.max`) — so a column of plays reads
 * as a ranking at a glance (proto-1792667077-4bakda's list).
 */
function PlayCountCell(props: {
  count: number;
  extent: FieldExtent | null;
}): ReactNode {
  const { count, extent } = props;
  const fraction =
    extent !== null && extent.max > 0 ? Math.min(1, count / extent.max) : 0;
  return (
    <Inline gap="xs">
      {count}
      <Clip
        aria-hidden
        className={cn(
          "h-0.75 w-10 rounded-full bg-foreground/10",
          rigidClass(),
        )}
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${(fraction * 100).toFixed(0)}%` }}
        />
      </Clip>
    </Inline>
  );
}

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
      icon: playsIcon,
      // The cell: the count beside its bar against the view's most played
      // (hence `extent`); the card token: the compact `N×`.
      extent: true,
      cell: (n, _row, { extent }) => (
        <PlayCountCell count={n} extent={extent} />
      ),
      token: (n) => `${n}×`,
      width: "5.75rem",
    },
    lastPlayedAt: {
      icon: lastPlayedIcon,
      cell: (at) => (at ? formatRelativeTime(at) : "—"),
      width: "8rem",
    },
  },
});
