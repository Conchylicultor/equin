import { useEffect, useRef, useState, type MouseEvent, type Ref } from "react";
import {
  SURFACE_LEVELS,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { SEEK_RUN_MS, TOUCH_SKIP_SECONDS } from "../internal/geometry";
import {
  clamp,
  formatTime,
  fractionAt,
  rateShort,
  sameRate,
  volumeGlyph,
} from "../internal/math";
import { NO_TAPS, judgeTap, sideAt, type TapMemory } from "../internal/taps";
import { useMediaTime } from "../internal/use-media-state";

const playIcon = symbol("play-arrow");
const pauseIcon = symbol("pause");
const replayIcon = symbol("replay");
const backIcon = symbol("replay-10");
const forwardIcon = symbol("forward-10");
const volumeUpIcon = symbol("volume-up");
const volumeOffIcon = symbol("volume-off");
const settingsIcon = symbol("settings");
const fullscreenIcon = symbol("fullscreen");
const fullscreenExitIcon = symbol("fullscreen-exit");
const leftIcon = symbol("arrow-left");
const rightIcon = symbol("arrow-right");

/** The centre buttons are float glass, like the desktop pill. */
const GLASS = SURFACE_LEVELS.float;

export interface TouchControlsProps {
  el: HTMLMediaElement | null;
  label: string;
  /** The controls show (a tap toggles them; playing, they hide on their own). */
  shown: boolean;
  paused: boolean;
  ended: boolean;
  duration: number;
  /** What the volume reads as (0 when muted). */
  volume: number;
  rate: number;
  remaining: boolean;
  fullscreen: boolean;
  settingsOpen: boolean;
  /** A tap on the picture that is not part of a double-tap: show or hide the controls. */
  onTap(): void;
  /** Something was pressed: the controls stay up for a full spell. */
  onWake(): void;
  onPlay(): void;
  /** Seek by `seconds` (negative: back). */
  onSkip(seconds: number): void;
  onMute(): void;
  onToggleRemaining(): void;
  onSettings(): void;
  onFullscreen(): void;
  onSeek(time: number): void;
  onSeekDrag(dragging: boolean): void;
  gearRef: Ref<HTMLSpanElement>;
}

/** The feedback of a side seek run: which side, how far so far. */
interface Run {
  side: "left" | "right";
  seconds: number;
  n: number;
}

/**
 * The touch controls (`proto-1794361798-f9dak8`), YouTube's model: a tap on
 * the picture shows or hides the controls — never plays or pauses; play and
 * ±10 s sit small in the centre; a double-tap on a side seeks 10 s, and each
 * further tap on that side 10 s more; mute and settings at the top; the time
 * (tap: what is left) and full screen — alone in its corner, out of reach of
 * the centre — at the bottom; the bar flush on the bottom edge, there whether
 * the controls show or not.
 */
export function TouchControls(props: TouchControlsProps) {
  const {
    el,
    label,
    shown,
    paused,
    ended,
    volume,
    rate,
    fullscreen,
    settingsOpen,
    onTap,
    onWake,
    onPlay,
    onSkip,
    onMute,
    onSettings,
    onFullscreen,
    gearRef,
  } = props;
  const memory = useRef<TapMemory>(NO_TAPS);
  const tapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const runTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [run, setRun] = useState<Run | null>(null);
  useEffect(
    () => () => {
      clearTimeout(tapTimer.current);
      clearTimeout(runTimer.current);
    },
    [],
  );

  const sideSeek = (side: "left" | "right") => {
    if (!el) return;
    const dir = side === "left" ? -1 : 1;
    const end = Number.isFinite(el.duration) ? el.duration : 0;
    if ((dir < 0 && el.currentTime <= 0) || (dir > 0 && el.currentTime >= end))
      return;
    onSkip(dir * TOUCH_SKIP_SECONDS);
    setRun((r) => ({
      side,
      seconds:
        (r !== null && r.side === side ? r.seconds : 0) + TOUCH_SKIP_SECONDS,
      n: (r?.n ?? 0) + 1,
    }));
    clearTimeout(runTimer.current);
    runTimer.current = setTimeout(() => setRun(null), SEEK_RUN_MS);
  };

  const onSurfaceClick = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const side = sideAt(fractionAt(e.clientX, box.left, box.width));
    const judged = judgeTap(memory.current, performance.now(), side);
    memory.current = judged.memory;
    clearTimeout(tapTimer.current);
    if (judged.verdict.kind === "seek") {
      sideSeek(judged.verdict.side);
      return;
    }
    tapTimer.current = setTimeout(() => {
      memory.current = { ...memory.current, last: null };
      onTap();
    }, judged.verdict.delay);
  };

  const press = (fn: () => void) => () => {
    fn();
    onWake();
  };
  const muteLabel = volume === 0 ? "Unmute" : "Mute";

  return (
    <>
      <div className="mp-t-frame">
        <div className="mp-t-surface" onClick={onSurfaceClick} />
        <Ripple side="left" run={run} />
        <Ripple side="right" run={run} />
        <div className="mp-t-chrome" data-shown={shown || undefined}>
          <div className="mp-t-top">
            <Text variant="body" className="mp-t-title mp-t-fade">
              {label}
            </Text>
            <TouchButton
              icon={
                volumeGlyph(volume) === "off" ? volumeOffIcon : volumeUpIcon
              }
              label={muteLabel}
              className="mp-t-fade"
              onClick={press(onMute)}
            />
            <span ref={gearRef} className="mp-gear mp-t-fade">
              <TouchButton
                icon={settingsIcon}
                label="Settings"
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                onClick={press(onSettings)}
              />
              {!sameRate(rate, 1) && (
                <Text className="mp-badge text-tag-compact font-bold tabular-nums">
                  {rateShort(rate)}
                </Text>
              )}
            </span>
          </div>
          <div className="mp-t-center">
            <TouchButton
              icon={backIcon}
              label={`Back ${TOUCH_SKIP_SECONDS} seconds`}
              className={cn("mp-t-skip mp-t-fade", GLASS)}
              onClick={press(() => onSkip(-TOUCH_SKIP_SECONDS))}
            />
            <TouchButton
              icon={ended ? replayIcon : paused ? playIcon : pauseIcon}
              label={ended ? "Replay" : paused ? "Play" : "Pause"}
              className={cn("mp-t-play mp-t-fade", GLASS)}
              onClick={press(onPlay)}
            />
            <TouchButton
              icon={forwardIcon}
              label={`Forward ${TOUCH_SKIP_SECONDS} seconds`}
              className={cn("mp-t-skip mp-t-fade", GLASS)}
              onClick={press(() => onSkip(TOUCH_SKIP_SECONDS))}
            />
          </div>
          <div className="mp-t-bottom">
            <TouchTime
              el={el}
              duration={props.duration}
              remaining={props.remaining}
              onClick={press(props.onToggleRemaining)}
            />
            <TouchButton
              icon={fullscreen ? fullscreenExitIcon : fullscreenIcon}
              label={fullscreen ? "Exit full screen" : "Full screen"}
              className="mp-fs mp-t-fade"
              onClick={press(onFullscreen)}
            />
          </div>
        </div>
      </div>
      <TouchSeekBar
        el={el}
        duration={props.duration}
        onSeek={props.onSeek}
        onDragChange={props.onSeekDrag}
      />
    </>
  );
}

function TouchButton({
  icon,
  label,
  className,
  onClick,
  ...aria
}: {
  icon: IconRef;
  label: string;
  className?: string;
  onClick(): void;
  "aria-haspopup"?: "dialog";
  "aria-expanded"?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn("mp-t-btn rounded-full", className)}
      onClick={(e) => {
        // A button's tap is the button's: never also a tap on the picture.
        e.stopPropagation();
        onClick();
      }}
      {...aria}
    >
      <Icon icon={icon} />
    </button>
  );
}

/** A side seek's feedback: a shaded half-moon on its side, chevrons running, the seconds so far. */
function Ripple({ side, run }: { side: "left" | "right"; run: Run | null }) {
  const on = run !== null && run.side === side;
  const chevron = side === "left" ? leftIcon : rightIcon;
  return (
    <div
      className="mp-t-ripple"
      data-side={side}
      data-on={on || undefined}
      aria-hidden
    >
      <span className="mp-t-chevrons">
        <Icon icon={chevron} />
        <Icon icon={chevron} />
        <Icon icon={chevron} />
      </span>
      <Text variant="caption" className="mp-t-ripple-label">
        {on ? `${run.seconds} seconds` : ""}
      </Text>
    </div>
  );
}

/** The time at the bottom left — current / total, or what is left. Follows the playhead. */
function TouchTime({
  el,
  duration,
  remaining,
  onClick,
}: {
  el: HTMLMediaElement | null;
  duration: number;
  remaining: boolean;
  onClick(): void;
}) {
  const { currentTime } = useMediaTime(el);
  const d = Number.isFinite(duration) ? duration : 0;
  return (
    <button
      type="button"
      className="mp-t-time mp-t-fade"
      aria-label={remaining ? "Show the total" : "Show the time left"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Text variant="caption" className="tabular-nums">
        {formatTime(currentTime)}
        <span className="mp-t-dur">
          {" / "}
          {remaining ? `-${formatTime(d - currentTime)}` : formatTime(d)}
        </span>
      </Text>
    </button>
  );
}

/**
 * The bar, flush on the player's bottom edge: the track alone is clipped to
 * the player's rounded corners (so its ends follow the curve), the thumb sits
 * outside that clip and is never cut. A drag seeks live, the time in a bubble
 * over the finger; playback pauses through it (`onDragChange`).
 */
function TouchSeekBar({
  el,
  duration,
  onSeek,
  onDragChange,
}: {
  el: HTMLMediaElement | null;
  duration: number;
  onSeek(time: number): void;
  onDragChange(dragging: boolean): void;
}) {
  const { currentTime, buffered } = useMediaTime(el);
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const dragging = useRef(false);
  const d = Number.isFinite(duration) ? duration : 0;
  const shownTime = drag ?? currentTime;
  const f = d > 0 ? clamp(shownTime / d, 0, 1) : 0;

  const timeAt = (x: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    return r ? fractionAt(x, r.left, r.width) * d : 0;
  };
  const move = (x: number) => {
    const t = timeAt(x);
    setDrag(t);
    onSeek(t);
  };
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setDrag(null);
    onDragChange(false);
  };

  return (
    <div className="mp-t-seek" data-dragging={drag !== null || undefined}>
      <div className="mp-t-trackclip">
        <div ref={trackRef} className="mp-t-track">
          <div
            className="mp-buffered"
            style={{
              width: `${(d > 0 ? clamp(buffered / d, 0, 1) : 0) * 100}%`,
            }}
          />
          <div className="mp-played" style={{ width: `${f * 100}%` }} />
        </div>
      </div>
      <div
        className="mp-t-hit"
        role="slider"
        tabIndex={-1}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(d)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatTime(currentTime)} of ${formatTime(d)}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          onDragChange(true);
          move(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) move(e.clientX);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      >
        <div className="mp-t-thumb" style={{ left: `${f * 100}%` }} />
        <div
          className="mp-t-bubble"
          // Kept inside the bar: its half-width from either end.
          style={{ left: `clamp(28px, ${f * 100}%, calc(100% - 28px))` }}
        >
          <Text variant="caption" className="mp-bubble-time tabular-nums">
            {formatTime(shownTime)}
          </Text>
        </div>
      </div>
    </div>
  );
}
