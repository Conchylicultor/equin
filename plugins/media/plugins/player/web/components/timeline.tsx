import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { formatTime } from "../internal/math";
import { useMediaTime } from "../internal/use-media-state";
import { SeekBar } from "./seek-bar";

/**
 * The pill's middle: current time · seek bar · time left (click: the total).
 * The one part of the player that follows the playhead, so a `timeupdate`
 * re-renders only this.
 */
export function Timeline({
  el,
  duration,
  remaining,
  onToggleRemaining,
  onSeek,
  onSeekDrag,
}: {
  el: HTMLMediaElement | null;
  duration: number;
  remaining: boolean;
  onToggleRemaining(): void;
  onSeek(time: number): void;
  onSeekDrag(dragging: boolean): void;
}) {
  const { currentTime, buffered } = useMediaTime(el);
  const d = Number.isFinite(duration) ? duration : 0;
  return (
    <>
      <Text variant="body" className="mp-time tabular-nums">
        {formatTime(currentTime)}
      </Text>
      <SeekBar
        currentTime={currentTime}
        duration={duration}
        buffered={buffered}
        video={el instanceof HTMLVideoElement ? el : null}
        onSeek={onSeek}
        onDragChange={onSeekDrag}
      />
      <Text
        variant="body"
        className="mp-time mp-time-total tabular-nums"
        onClick={onToggleRemaining}
      >
        {remaining ? `-${formatTime(d - currentTime)}` : formatTime(d)}
      </Text>
    </>
  );
}
