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
  rate,
  remaining,
  onToggleRemaining,
  onSeek,
  onSeekDrag,
}: {
  el: HTMLMediaElement | null;
  duration: number;
  rate: number;
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
        rate={rate}
        // `el` first: no element (a static render) means no DOM, and no
        // `HTMLVideoElement` class to test against.
        // eslint-disable-next-line dom-access-safety/no-render-time-dom -- read only once `el`, a mounted element, exists — never in a static render
        video={el !== null && el instanceof HTMLVideoElement ? el : null}
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
