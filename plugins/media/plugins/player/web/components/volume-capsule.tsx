import type {
  CSSProperties,
  FocusEventHandler,
  KeyboardEvent,
  PointerEvent,
  PointerEventHandler,
  Ref,
} from "react";
import {
  SURFACE_LEVELS,
  cn,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { Theme } from "@plugins/primitives/plugins/css/plugins/theme-boundary/web";
import { Slider } from "@plugins/primitives/plugins/css/plugins/slider/web";
import { VOLUME_STEP } from "../internal/math";
import { mediaVolumeThemeScope } from "../internal/theme";

/** The capsule's own keys: a step of the level each. */
const KEY_STEPS: Record<string, number> = {
  ArrowUp: VOLUME_STEP,
  ArrowRight: VOLUME_STEP,
  ArrowDown: -VOLUME_STEP,
  ArrowLeft: -VOLUME_STEP,
};

/**
 * The volume capsule: a vertical slider in a glass capsule centred over the
 * speaker, a little above the pill. Open while the speaker or the capsule is
 * hovered (an invisible bridge spans the gap), or while either has focus.
 * Rises and grows from the button as it opens. No number: the thumb is the
 * level. A drag is continuous; a key or a wheel notch steps 5%.
 *
 * It is drawn outside the pill (its blur must see the picture, not the
 * pill's glass), so it sits in the tab order right after the speaker by hand:
 * Tab from the speaker comes in, Tab / Shift+Tab here go on / back
 * (`onTab`).
 */
export function VolumeCapsule({
  open,
  place,
  volume,
  onVolume,
  onPointerEnter,
  onPointerLeave,
  onBlur,
  onTab,
  onDragChange,
  sliderRef,
  ref,
}: {
  open: boolean;
  place: CSSProperties;
  /** What it reads as: 0 when muted. */
  volume: number;
  onVolume(v: number): void;
  onPointerEnter: PointerEventHandler<HTMLElement>;
  onPointerLeave: PointerEventHandler<HTMLElement>;
  /** Focus left an element of the capsule (to wherever `relatedTarget` says). */
  onBlur: FocusEventHandler<HTMLElement>;
  onTab(back: boolean): void;
  onDragChange(dragging: boolean): void;
  sliderRef: Ref<HTMLInputElement>;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <Theme
      name={mediaVolumeThemeScope}
      surface="none"
      ref={ref}
      role="group"
      aria-label="Volume"
      inert={!open}
      data-open={open || undefined}
      style={place}
      className={cn(SURFACE_LEVELS.float, "mp-pop mp-volume rounded-full")}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
    >
      <Slider
        ref={sliderRef}
        orientation="vertical"
        className="mp-vslider"
        aria-label="Volume"
        value={volume}
        min={0}
        max={1}
        onValueChange={onVolume}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Tab") {
            e.preventDefault();
            onTab(e.shiftKey);
            return;
          }
          const step = KEY_STEPS[e.key];
          if (step === undefined) return;
          // 5% a press, as the prototype; the input's own step is continuous.
          e.preventDefault();
          e.stopPropagation();
          onVolume(volume + step);
        }}
        onPointerDown={(e: PointerEvent<HTMLInputElement>) => {
          if (e.button === 0) onDragChange(true);
        }}
        onPointerUp={() => onDragChange(false)}
        onPointerCancel={() => onDragChange(false)}
        onLostPointerCapture={() => onDragChange(false)}
      />
    </Theme>
  );
}
