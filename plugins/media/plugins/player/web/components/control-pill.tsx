import type {
  FocusEventHandler,
  KeyboardEventHandler,
  PointerEventHandler,
  Ref,
} from "react";
import {
  ControlSizeProvider,
  SURFACE_LEVELS,
  TooltipProvider,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { TOOLTIP_DELAY_MS } from "../internal/geometry";
import { rateShort, sameRate, volumeGlyph } from "../internal/math";
import { Timeline } from "./timeline";

const playIcon = symbol("play-arrow");
const pauseIcon = symbol("pause");
const volumeUpIcon = symbol("volume-up");
const volumeDownIcon = symbol("volume-down");
const volumeOffIcon = symbol("volume-off");
const settingsIcon = symbol("settings");
const fullscreenIcon = symbol("fullscreen");
const fullscreenExitIcon = symbol("fullscreen-exit");

const VOLUME_ICONS = {
  off: volumeOffIcon,
  down: volumeDownIcon,
  up: volumeUpIcon,
} as const;

export interface ControlPillProps {
  kind: "video" | "audio";
  el: HTMLMediaElement | null;
  paused: boolean;
  duration: number;
  /** What the volume reads as (0 when muted). */
  volume: number;
  rate: number;
  /** The right-hand time shows what is left (`-0:42`) rather than the total. */
  remaining: boolean;
  settingsOpen: boolean;
  volumeOpen: boolean;
  fullscreen: boolean;
  onPlay(): void;
  onMute(): void;
  onSeek(time: number): void;
  onSeekDrag(dragging: boolean): void;
  onToggleRemaining(): void;
  onSettings(): void;
  onFullscreen(): void;
  /** The speaker opens the volume capsule while hovered or focused. */
  onSpeakerEnter: PointerEventHandler<HTMLElement>;
  onSpeakerLeave: PointerEventHandler<HTMLElement>;
  onSpeakerFocus: FocusEventHandler<HTMLElement>;
  onSpeakerBlur: FocusEventHandler<HTMLElement>;
  /** Tab from the speaker goes into the open capsule (drawn outside the pill). */
  onSpeakerKeyDown: KeyboardEventHandler<HTMLElement>;
  speakerRef: Ref<HTMLSpanElement>;
  gearRef: Ref<HTMLSpanElement>;
  ref?: Ref<HTMLDivElement>;
}

/**
 * The control pill: play · volume · time · seek bar · time left (click: the
 * total) · settings · full screen, on float glass. The gear wears the speed
 * as a badge when it is not 1×, and turns while its panel is open. Tooltips
 * come after a short rest; the end buttons' align to the pill's ends, and the
 * button whose panel is open shows none (it would sit over the panel) —
 * hidden by `media-player.css`, not dropped: a tooltip that comes and goes
 * remounts its trigger, which would lose the speaker's keyboard focus.
 */
export function ControlPill({
  kind,
  el,
  paused,
  duration,
  volume,
  rate,
  remaining,
  settingsOpen,
  volumeOpen,
  fullscreen,
  onPlay,
  onMute,
  onSeek,
  onSeekDrag,
  onToggleRemaining,
  onSettings,
  onFullscreen,
  onSpeakerEnter,
  onSpeakerLeave,
  onSpeakerFocus,
  onSpeakerBlur,
  onSpeakerKeyDown,
  speakerRef,
  gearRef,
  ref,
}: ControlPillProps) {
  const muteLabel = volume === 0 ? "Unmute" : "Mute";
  return (
    <div ref={ref} className={cn(SURFACE_LEVELS.float, "mp-pill rounded-full")}>
      <ControlSizeProvider size="sm">
        <TooltipProvider delay={TOOLTIP_DELAY_MS}>
          <div className="mp-row">
            <IconButton
              icon={paused ? playIcon : pauseIcon}
              label={paused ? "Play" : "Pause"}
              shortcut="space"
              shape="pill"
              tooltipAlign="start"
              onClick={onPlay}
            />
            <span
              ref={speakerRef}
              onPointerEnter={onSpeakerEnter}
              onPointerLeave={onSpeakerLeave}
              onFocus={onSpeakerFocus}
              onBlur={onSpeakerBlur}
              onKeyDown={onSpeakerKeyDown}
            >
              <IconButton
                icon={VOLUME_ICONS[volumeGlyph(volume)]}
                label={muteLabel}
                tooltip={<span className="mp-mute-tip">{muteLabel}</span>}
                shortcut="m"
                shape="pill"
                data-open={volumeOpen || undefined}
                onClick={onMute}
              />
            </span>
            <Timeline
              el={el}
              duration={duration}
              remaining={remaining}
              onToggleRemaining={onToggleRemaining}
              onSeek={onSeek}
              onSeekDrag={onSeekDrag}
            />
            <span ref={gearRef} className="mp-gear">
              <IconButton
                icon={settingsIcon}
                label="Settings"
                tooltip={<span className="mp-gear-tip">Settings</span>}
                tooltipAlign={kind === "audio" ? "end" : undefined}
                shape="pill"
                aria-haspopup="dialog"
                aria-expanded={settingsOpen}
                data-open={settingsOpen || undefined}
                onClick={onSettings}
              />
              {!sameRate(rate, 1) && (
                <Text className="mp-badge text-tag-compact font-bold tabular-nums">
                  {rateShort(rate)}
                </Text>
              )}
            </span>
            {kind === "video" && (
              <IconButton
                icon={fullscreen ? fullscreenExitIcon : fullscreenIcon}
                label={fullscreen ? "Exit full screen" : "Full screen"}
                shortcut="f"
                shape="pill"
                tooltipAlign="end"
                className="mp-fs"
                onClick={onFullscreen}
              />
            )}
          </div>
        </TooltipProvider>
      </ControlSizeProvider>
    </div>
  );
}
